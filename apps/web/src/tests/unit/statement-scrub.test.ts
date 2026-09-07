/**
 * `scrubStatementForAudit` — what `database.queried` may keep of a statement
 *.
 *
 * `redactFields` keys on a field's *name*, and the field is `query`, so the
 * recorded statement went to `audit_log.metadata` and stdout verbatim. The
 * value-level scrub is what stands between a pasted `set password = '…'` and
 * the trail; every arm below is a way a literal can be spelled in Postgres.
 */

import { describe, expect, it } from "vitest"

import { scrubStatementForAudit } from "@/server/admin/database"

describe("scrubStatementForAudit", () => {
  it("replaces a long literal and keeps a short one", () => {
    expect(
      scrubStatementForAudit(
        `select id from "user" where status = 'active' and email = 'somebody@example.com'`
      )
    ).toBe(
      `select id from "user" where status = 'active' and email = '[redacted]'`
    )
  })

  it("keeps identifiers, keywords, numbers and operators", () => {
    const statement = `select count(*)::int as n, "hashed_secret" from oauth_client where id <> 42 limit 5`
    // `hashed_secret` is an identifier and stays — the row has to say which
    // column was read — but it flips the keyword rule for what follows.
    expect(scrubStatementForAudit(statement)).toBe(statement)
  })

  it("redacts every literal after a password, secret or token keyword, however short", () => {
    expect(
      scrubStatementForAudit(`update account set password = 'abc' where id = 'u1'`)
    ).toBe(`update account set password = '[redacted]' where id = '[redacted]'`)
    expect(
      scrubStatementForAudit(`select 'ok' as a, "refresh_token", 'x' from t`)
    ).toBe(`select 'ok' as a, "refresh_token", '[redacted]' from t`)
    expect(scrubStatementForAudit(`select newPassword, 'p' from t`)).toBe(
      `select newPassword, '[redacted]' from t`
    )
  })

  it("treats a doubled quote as part of the literal, not its end", () => {
    // `'it''s a long secret'` is one literal; a naive scanner would close at
    // the doubled quote and leak the rest as bare SQL.
    expect(
      scrubStatementForAudit(`select 'it''s a long secret' as v, 'ab''c' as w`)
    ).toBe(`select '[redacted]' as v, 'ab''c' as w`)
  })

  it("handles escape strings and their backslashes", () => {
    expect(
      scrubStatementForAudit(`select E'line\\'break-and-more' as v, E'a\\'b' as w`)
    ).toBe(`select '[redacted]' as v, E'a\\'b' as w`)
  })

  it("redacts a dollar-quoted body whole, tagged or not", () => {
    expect(
      scrubStatementForAudit(`select $$short$$, $fn$ begin return 'x'; end $fn$`)
    ).toBe(`select $$[redacted]$$, $fn$[redacted]$fn$`)
  })

  it("drops comments, which are where pasted notes end up", () => {
    expect(
      scrubStatementForAudit(
        `select 1 -- password: hunter2\n/* token abc */ from t`
      )
    ).toBe(`select 1 \n from t`)
  })

  it("redacts an unterminated literal to the end, so a cut cannot expose it", () => {
    expect(scrubStatementForAudit(`select 'never closed`)).toBe(
      `select '[redacted]'`
    )
    expect(scrubStatementForAudit(`select $$never closed`)).toBe(
      `select $$[redacted]$$`
    )
  })

  it("leaves a statement with nothing to hide alone", () => {
    const statement = `select * from "user" order by created_at desc limit 100`
    expect(scrubStatementForAudit(statement)).toBe(statement)
  })
})
