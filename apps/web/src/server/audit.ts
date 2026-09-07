/**
 * Audit trail.
 *
 * Every recorded event goes to two places: an append-only row in `audit_log`,
 * browsable at `/admin/audit` and retained for `audit.retentionDays`, and a
 * structured stdout line, so a deployment that ships logs elsewhere sees the
 * same events without querying the database.
 *
 * A failure to write the row must never fail the action that caused it — an
 * audit outage would otherwise become an authentication outage — so writes are
 * best-effort and a failure is itself logged loudly.
 *
 * No secrets are ever stored: `metadata` carries identifiers and outcomes. The
 * same redaction that protects the logs is applied to it.
 */

import type { DbHandle } from "./db/client"
import type { AuditAction } from "./auth/plugins/idp-plugin"
import { redactFields } from "./logger"
import { currentRequest, currentRequestId } from "./http/request-log"
import type { LogFields, Logger } from "./logger"

export type AuditOutcome = "success" | "failure" | "denied"

export interface AuditEvent {
  action: AuditAction
  outcome: AuditOutcome
  /** Who caused it. Absent for anonymous and system events. */
  actorUserId?: string
  /** How they authenticated. `system` for startup steps, `cli` for the operator CLI. */
  actorType?: "session" | "api-key" | "system" | "cli" | "anonymous"
  /** What it happened to. */
  target?: { type: string; id: string }
  /**
   * There is deliberately no `ipAddress` here. The address on the row is the
   * one the edge resolved for this request under `server.trustProxy`, read
   * from the request context below; a caller-supplied value used to take
   * precedence over it, which meant any future call site reading a raw
   * `X-Forwarded-For` — attacker-controlled at the left — could write a
   * spoofed address into the trail simply by passing one (security review
   * 2026-09). Nothing in the tree ever passed a real value.
   */
  userAgent?: string | null
  requestId?: string
  metadata?: LogFields
}

export interface Audit {
  record: (event: AuditEvent) => Promise<void>
  /** Fire-and-forget, for call sites that must not await. */
  recordDetached: (event: AuditEvent) => void
}

export function createAudit(database: DbHandle, logger: Logger): Audit {
  const record = async (event: AuditEvent): Promise<void> => {
    const metadata = event.metadata ? redactFields(event.metadata) : undefined

    // stdout first: if the database write fails, the event is still on record.
    logger.info(`audit ${event.action}`, {
      audit: true,
      action: event.action,
      outcome: event.outcome,
      actorUserId: event.actorUserId,
      actorType: event.actorType,
      targetType: event.target?.type,
      targetId: event.target?.id,
      // falls back to the id the edge minted for this request, so the
      // trail and the request log can be read side by side. `undefined`
      // outside a request — start-up, the CLI, a background job — and that is
      // an ordinary answer rather than a missing one.
      requestId: event.requestId ?? currentRequestId(),
      metadata,
    })

    try {
      await database.db.insert(database.schema.auditLog).values({
        id: crypto.randomUUID(),
        action: event.action,
        outcome: event.outcome,
        actorUserId: event.actorUserId ?? null,
        actorType: event.actorType ?? null,
        targetType: event.target?.type ?? null,
        targetId: event.target?.id ?? null,
        // The edge already resolved and anonymized the caller's address using
        // `server.trustProxy`, and it is the only source: see `AuditEvent`.
        ipAddress: currentRequest()?.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
        requestId: event.requestId ?? currentRequestId() ?? null,
        metadata: metadata ?? null,
        createdAt: new Date(),
      })
    } catch (error) {
      // Loud, because a silent audit gap is worse than a noisy one.
      logger.error("audit write failed", { action: event.action, err: error })
    }
  }

  return {
    record,
    recordDetached: (event) => {
      void record(event)
    },
  }
}

/** An audit that only writes to the log. Used before the database is up. */
export function createLogOnlyAudit(logger: Logger): Audit {
  const record = async (event: AuditEvent): Promise<void> => {
    logger.info(`audit ${event.action}`, {
      audit: true,
      action: event.action,
      outcome: event.outcome,
      actorUserId: event.actorUserId,
      actorType: event.actorType,
      metadata: event.metadata ? redactFields(event.metadata) : undefined,
    })
  }
  return { record, recordDetached: (event) => void record(event) }
}
