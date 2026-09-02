/**
 * Runs a command against a **local** Postgres, starting one if it has to.
 *
 * The integration suite was taking **54 minutes**. Almost none of that was the
 * application: the default test database was the deployment's own Neon
 * instance in `us-east-2`, and from here that is **~102 ms per round trip**.
 * Every context this suite builds drops a schema and applies 77 migration
 * statements one at a time — about eight seconds of latency each, before a
 * single assertion — and there are more than a hundred of them, all serialized
 * by `fileParallelism: false`. Against a container on loopback the same suite
 * is **~3 minutes**, and the tests are unchanged: the round trip went from
 * 102 ms to a fraction of one.
 *
 * That is also the only honest place to run it. A test schema on the
 * deployment's database is one `IDP_SCHEMA_NAME` typo away from the persistent
 * `idp` schema, which is the thing AGENTS.md says never to touch; a throwaway
 * container cannot reach it at all.
 *
 * Three rules:
 *
 *  - **`IDP_TEST_DATABASE_URL` wins.** CI supplies a service container, and
 *    anyone who genuinely wants to run against a hosted database still can.
 *    Nothing here runs in that case.
 *  - **The container is stopped when the run that started it ends, and kept.**
 *    A run leaves the machine the way it found it: whichever branch below
 *    started the container stops it again after the command exits. Stopped,
 *    not removed — the preserved data directory makes the next start a second
 *    or two instead of an `initdb`, and a stopped container holds no port and
 *    no CPU. The one case that is left alone is a container that was already
 *    running when this script arrived: that is either a concurrent run or a
 *    deliberate manual start, and stopping it out from under either would
 *    break something this script did not start. `docker rm -f idp-test-db`
 *    when you want it gone entirely.
 *  - **No Docker is not a failure.** If the daemon is not there, this falls
 *    back to whatever `.env` provides and says so, because a machine without
 *    Docker should still be able to run the suite slowly rather than not at
 *    all.
 */

import { spawn, spawnSync } from "node:child_process"

const CONTAINER = "idp-test-db"
/** Not 5432: a developer's own Postgres is usually already there. */
const PORT = 55432
const IMAGE = "postgres:17.4-alpine"
const URL = `postgresql://idp:idp@127.0.0.1:${PORT}/idp?sslmode=disable`

/**
 * The real shape of a `spawnSync` result, which its types are optimistic about.
 *
 * With `encoding: "utf8"` they promise `string`, and that is true of a process
 * that ran. When the binary is not there at all — the whole case this script
 * exists to survive — `status`, `stdout` and `stderr` are every one of them
 * `null`, and reading `.trim()` off the optimistic type throws where a
 * fallback was intended.
 */
interface CommandResult {
  status: number | null
  stdout: string | null
  stderr: string | null
}

function docker(...args: string[]): { ok: boolean; out: string } {
  const result: CommandResult = spawnSync("docker", args, { encoding: "utf8" })
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  }
}

/** Whether the container exists at all, and whether it is running. */
function state(): "running" | "stopped" | "absent" {
  const found = docker(
    "ps",
    "-a",
    "--filter",
    `name=^/${CONTAINER}$`,
    "--format",
    "{{.State}}"
  )
  if (!found.ok || found.out === "") return "absent"
  return found.out.startsWith("running") ? "running" : "stopped"
}

function ready(): boolean {
  return docker("exec", CONTAINER, "pg_isready", "-U", "idp", "-q").ok
}

async function waitForReady(): Promise<boolean> {
  // Postgres accepts connections a moment after the container starts, and the
  // first run also has to initialize the data directory.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (ready()) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/**
 * Whether this invocation is the one that started the container, and therefore
 * the one responsible for stopping it. Left `false` when the container was
 * already running — see the header: that one belongs to whoever started it.
 */
let startedHere = false

async function ensureDatabase(): Promise<string | undefined> {
  if (!docker("version", "--format", "{{.Server.Version}}").ok) return undefined

  switch (state()) {
    case "running":
      break
    case "stopped": {
      if (!docker("start", CONTAINER).ok) return undefined
      startedHere = true
      break
    }
    case "absent": {
      const created = docker(
        "run",
        "-d",
        "--name",
        CONTAINER,
        "-e",
        "POSTGRES_USER=idp",
        "-e",
        "POSTGRES_PASSWORD=idp",
        "-e",
        "POSTGRES_DB=idp",
        "-p",
        `${PORT}:5432`,
        // The suite creates and drops a schema per context, so durability buys
        // nothing and costs an fsync on every one of them.
        IMAGE,
        "-c",
        "fsync=off",
        "-c",
        "synchronous_commit=off",
        "-c",
        "full_page_writes=off"
      )
      if (!created.ok) {
        console.error(`test database: could not start ${IMAGE}\n${created.out}`)
        return undefined
      }
      console.error(`test database: started ${CONTAINER} on port ${PORT}`)
      startedHere = true
      break
    }
  }

  return (await waitForReady()) ? URL : undefined
}

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error("usage: bun run scripts/test-database.ts <command> [args…]")
  process.exit(2)
}

const env = { ...process.env }

if (env.IDP_TEST_DATABASE_URL) {
  console.error("test database: using IDP_TEST_DATABASE_URL from the environment")
} else {
  const url = await ensureDatabase()
  if (url) {
    env.IDP_TEST_DATABASE_URL = url
  } else {
    console.error(
      "test database: no local Postgres (is Docker running?) — falling back to " +
        "the .env connection string, which is much slower. Set " +
        "IDP_TEST_DATABASE_URL to choose one explicitly."
    )
  }
}

const child = spawn(command, args, { stdio: "inherit", env, shell: true })
child.on("exit", (code, signal) => {
  if (startedHere) {
    // With fsync off Postgres has nothing to flush, so the fast-shutdown grace
    // of 2 s is generous; -t caps it in case the daemon has gone away.
    docker("stop", "-t", "2", CONTAINER)
    console.error(`test database: stopped ${CONTAINER}`)
  }
  process.exit(signal ? 1 : (code ?? 1))
})
