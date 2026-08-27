/**
 * Refuses to ship the server to the browser (SEC-5, SEC-10).
 *
 * A TanStack Start route `loader` is isomorphic: it runs on the server for the
 * first paint and in the browser on every client-side navigation. So anything
 * a route module imports at the top level — even if only the loader touches it
 * — lands in the *client* bundle. That is exactly how Better Auth, Drizzle,
 * the `postgres` driver, the migrator and the advisory-lock SQL once ended up
 * in a 1 MB browser bundle that threw `ReferenceError: Buffer is not defined`
 * before React could hydrate.
 *
 * The fix is the `server/functions/` seam and `server.handlers` blocks, both of
 * which the Start plugin compiles out of the client build. This gate is what
 * stops a single innocent-looking import from undoing it: one `getRuntime()`
 * in a loader and the whole graph comes back.
 *
 *   bun run scripts/check-client-bundle.ts
 *
 * Run it after `pnpm --filter web run build`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const CLIENT_DIR = "apps/web/dist/client"
const SERVER_DIR = "apps/web/dist/server"

/**
 * Strings that exist only in server-side code.
 *
 * Each one is also asserted to be *present* in the server build, so a marker
 * that stops matching anything fails loudly instead of quietly passing for
 * ever. Pick strings a bundler cannot mangle: SQL text, package paths and
 * environment-variable names all survive minification; identifiers do not.
 */
const SERVER_ONLY_MARKERS = [
  { marker: "pg_try_advisory_lock", what: "the advisory-lock helper (DM-4)" },
  { marker: "drizzle", what: "Drizzle ORM" },
  { marker: "better-auth", what: "Better Auth" },
  { marker: "BETTER_AUTH_SECRET", what: "the secret's fallback env var" },
  { marker: "DATABASE_URL_ADMIN", what: "the direct connection string (D27)" },
  { marker: "__drizzle_migrations", what: "the migrations table" },
]

/**
 * The backstop, not the detector.
 *
 * The markers above are what actually catch a server leak; this catches the
 * shape of one — the incident it was written from put the browser bundle over
 * 1 MB. The number was 600 kB against a ~330 kB bundle, and the comment saying
 * so went stale: the client was ~600 kB when this was last raised, so the gate
 * had drifted into a tripwire that ordinary UI work sets off (the **D71**
 * toast, 25 kB, brought it to within 1.2 kB) while still passing anything
 * short of the megabyte it was aimed at. Raised to keep the headroom it was
 * written with. Update the measured figure here when it moves, so the next
 * person can see the drift.
 *
 * **679 kB today** — the **D80** row-actions menu added ~79 kB of Base UI
 * `Menu`. That is the second ordinary UI addition to spend the headroom, and
 * the next one will be close: at ~70 kB left this is worth a look rather than
 * another raise, since the markers are the real gate and the byte cap is only
 * the shape of the incident.
 */
const MAX_CLIENT_BYTES = 750_000

function jsFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    console.error(
      `${dir} does not exist. Run \`pnpm --filter web run build\` first.`
    )
    process.exit(2)
  }
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...jsFiles(path))
    else if (entry.endsWith(".js")) out.push(path)
  }
  return out
}

function main(): void {
  const clientFiles = jsFiles(CLIENT_DIR)
  const serverText = jsFiles(SERVER_DIR)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")

  const failures: string[] = []
  const staleMarkers: string[] = []

  for (const { marker, what } of SERVER_ONLY_MARKERS) {
    if (!serverText.includes(marker)) {
      staleMarkers.push(marker)
      continue
    }
    for (const path of clientFiles) {
      if (readFileSync(path, "utf8").includes(marker)) {
        failures.push(`${path} contains \`${marker}\` — ${what} reached the browser.`)
      }
    }
  }

  let clientBytes = 0
  for (const path of clientFiles) clientBytes += statSync(path).size
  if (clientBytes > MAX_CLIENT_BYTES) {
    failures.push(
      `client bundle is ${clientBytes} bytes, over the ${MAX_CLIENT_BYTES} ceiling — ` +
        "something large came along for the ride."
    )
  }

  if (staleMarkers.length > 0) {
    console.error(
      `These markers no longer appear in the server build, so they are guarding nothing: ${staleMarkers.join(", ")}.\n` +
        "Replace them with strings the current server bundle really contains."
    )
    process.exit(1)
  }

  if (failures.length > 0) {
    console.error("Server-only code reached the client bundle:\n")
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error(
      "\nA route `loader` runs in the browser too. Move the server work into a\n" +
        "`createServerFn` under `src/server/functions/`, or into the route's\n" +
        "`server.handlers` block — the Start plugin strips both from the client build."
    )
    process.exit(1)
  }

  console.log(
    `client bundle clean: ${clientFiles.length} files, ${clientBytes} bytes, no server-only markers.`
  )
}

main()
