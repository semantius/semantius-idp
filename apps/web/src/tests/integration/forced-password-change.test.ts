import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createLocalAccountIssuer } from "@better-auth/core/db"
import { eq } from "drizzle-orm"

import { authRequest, createTestContext, sessionCookie } from "./harness"
import type { TestContext } from "./harness"

/**
 * FR-AUTH-4 — both halves of it.
 *
 * The flag going *on* was covered; the flag coming *off* was not, and it never
 * happened. `mustChangePassword` was set by the bootstrap step and cleared by
 * nothing, so completing the forced change succeeded and the next sign-in
 * interposed the very same page — for ever. The bootstrap admin could not
 * reach any destination at all, which is also why the R-3 `/account` 404 was
 * never seen from that account.
 *
 * The half that must *not* change is equally load-bearing: an administrator
 * assigning a temporary password (FR-ADMIN-2) writes a password and raises
 * this same flag, so "any credential password write clears it" would quietly
 * undo the feature. Hence the endpoint list, and hence the second test.
 */
describe("forced password change (FR-AUTH-4)", () => {
  let ctx: TestContext
  const email = "forced@example.com"
  const temporary = "temporary password from an admin"
  const chosen = "the one the user actually picked"

  beforeAll(async () => {
    ctx = await createTestContext("forced-change")
  }, 120_000)
  afterAll(async () => await ctx.teardown())

  async function readFlag(): Promise<boolean | null> {
    const [row] = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.email, email))
    return row?.mustChangePassword ?? null
  }

  async function signIn(password: string): Promise<Response> {
    return ctx.auth.handler(
      authRequest("/sign-in/email", { json: { email, password } })
    )
  }

  it("clears the flag when the user completes the change themselves", async () => {
    // Created exactly the way the bootstrap step does it (startup.ts): a
    // temporary password, the flag raised, and no request behind any of it.
    const context = await ctx.auth.$context
    const created = await context.internalAdapter.createUser(
      {
        email,
        name: "Frankie Forced",
        emailVerified: true,
        status: "active",
        mustChangePassword: true,
      },
      { method: "admin" }
    )
    await context.internalAdapter.createAccount({
      userId: created.id,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: created.id,
      password: await context.password.hash(temporary),
    })

    expect(await readFlag()).toBe(true)

    const first = await signIn(temporary)
    expect(first.status).toBe(200)
    const cookie = sessionCookie(first)
    expect(cookie).toBeDefined()

    const changed = await ctx.auth.handler(
      authRequest("/change-password", {
        headers: { cookie: cookie! },
        json: {
          currentPassword: temporary,
          newPassword: chosen,
          revokeOtherSessions: true,
        },
      })
    )
    expect(changed.status).toBe(200)

    // The whole point: the interposition ends.
    expect(await readFlag()).toBe(false)

    const second = await signIn(chosen)
    expect(second.status).toBe(200)
    const body = (await second.json()) as { user?: { mustChangePassword?: boolean } }
    expect(body.user?.mustChangePassword).toBeFalsy()
  })

  it("leaves the flag alone for a password write with no request behind it", async () => {
    // `internalAdapter.updateAccount` reaches the hook with no context, which
    // is also how the bootstrap step and the CLI get there. None of them
    // should end a forced change. The endpoint list that separates a
    // self-service change from an admin-assigned temporary password is
    // asserted directly in `tests/unit/forced-password-change.test.ts`.
    const context = await ctx.auth.$context
    const [user] = await ctx.database.db
      .select()
      .from(ctx.database.schema.user)
      .where(eq(ctx.database.schema.user.email, email))

    await ctx.database.db
      .update(ctx.database.schema.user)
      .set({ mustChangePassword: true })
      .where(eq(ctx.database.schema.user.id, user!.id))

    const [account] = await ctx.database.db
      .select()
      .from(ctx.database.schema.account)
      .where(eq(ctx.database.schema.account.userId, user!.id))

    await context.internalAdapter.updateAccount(account!.id, {
      password: await context.password.hash("a new temporary one"),
    })

    expect(await readFlag()).toBe(true)
  })
})
