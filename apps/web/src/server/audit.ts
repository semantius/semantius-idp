/**
 * Audit trail (SEC-6).
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
 * same redaction that protects the logs is applied to it (SEC-5).
 */

import type { DbHandle } from "./db/client"
import type { AuditAction } from "./auth/plugins/idp-plugin"
import {
  anonymizeIp,
  redactFields
  
  
} from "./logger"
import type {LogFields, Logger} from "./logger";

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
  /** Anonymised before storage (SEC-5). */
  ipAddress?: string | null
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
      requestId: event.requestId,
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
        ipAddress: anonymizeIp(event.ipAddress) ?? null,
        userAgent: event.userAgent ?? null,
        requestId: event.requestId ?? null,
        metadata: (metadata ?? null),
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
