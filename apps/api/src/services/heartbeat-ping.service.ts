import type { Prisma } from "@prisma/client";
import type { HeartbeatPingKind } from "@inv/shared";
import { prisma } from "../db.js";
import { computeAfterPing, computeAfterStart } from "./heartbeat-schedule.js";
import {
  emitHeartbeatAlert,
  hashHeartbeatToken,
  heartbeatInclude,
  lastCompletionAt,
  type HeartbeatAlert,
  type HeartbeatWithServer,
} from "./heartbeat.service.js";

/**
 * Record one check-in from a job.
 *
 * Runs in a transaction holding `SELECT … FOR UPDATE` on the heartbeat row, so two
 * pings for the same heartbeat (a retrying curl, a start racing a finish) are
 * applied one after the other and each sees the other's result. The status edge —
 * and therefore the decision to alert — is made under that lock; the alert itself
 * is raised after commit, so a rolled-back ping can never have paged anyone.
 */

export interface PingInput {
  token: string;
  kind: HeartbeatPingKind;
  exitCode: number | null;
  body: string | null;
  bodyTruncated: boolean;
  remoteIp: string | null;
  userAgent: string | null;
  now?: Date;
}

export interface PingOutcome {
  heartbeatId: number;
  status: string;
  durationMs: number | null;
  alerts: HeartbeatAlert["kind"][];
}

const MAX_INT = 2_147_483_647;
const USER_AGENT_MAX = 200;

/** Returns null when no heartbeat has this token (the route answers 404). */
export async function recordHeartbeatPing(input: PingInput): Promise<PingOutcome | null> {
  const tokenHash = hashHeartbeatToken(input.token);
  const now = input.now ?? new Date();

  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: number }[]>`
      SELECT "id" FROM "heartbeat" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    const id = locked[0]?.id;
    if (id === undefined) return null;
    const hb = await tx.heartbeat.findUniqueOrThrow({ where: { id } });

    const data: Prisma.HeartbeatUpdateInput = { lastPingAt: now, lastPingKind: input.kind };
    const alerts: HeartbeatAlert[] = [];
    let status = hb.status;
    let durationMs: number | null = null;

    // A log line is a note, not a sign of life for the schedule: it never resumes a
    // paused heartbeat and never moves a deadline.
    let resumed = false;
    if (status === "paused" && hb.resumeOnPing && input.kind !== "log") {
      status = "new";
      resumed = true;
    }
    const paused = status === "paused";

    if (input.kind === "start") {
      data.lastStartAt = now;
      if (!paused) {
        const current = resumed ? { expectedAt: null, alertAt: null } : { expectedAt: hb.expectedAt, alertAt: hb.alertAt };
        const d = computeAfterStart(hb, now, current);
        data.expectedAt = d.expectedAt;
        data.alertAt = d.alertAt;
      }
    } else if (input.kind === "success" || input.kind === "fail") {
      // Duration only when this completion closes a run we saw start.
      const done = lastCompletionAt(hb);
      if (hb.lastStartAt && (!done || hb.lastStartAt > done)) {
        const ms = now.getTime() - hb.lastStartAt.getTime();
        if (ms >= 0 && ms <= MAX_INT) durationMs = ms;
      }
      if (durationMs !== null) data.lastDurationMs = durationMs;
      data.lastExitCode = input.exitCode;
      if (input.kind === "success") data.lastSuccessAt = now;
      else data.lastFailureAt = now;

      if (!paused) {
        const d = computeAfterPing(hb, now);
        data.expectedAt = d.expectedAt;
        data.alertAt = d.alertAt;
        if (input.kind === "success") {
          // late → up resolves only if "late" was announced in the first place.
          if (status === "down" || (status === "late" && hb.notifyOnLate)) alerts.push({ kind: "recover" });
          status = "up";
        } else {
          // Repeated failures while already down are recorded, not re-alerted.
          if (status !== "down") {
            alerts.push({
              kind: "fail",
              reason: input.exitCode !== null ? "exit_code" : "fail_signal",
              exitCode: input.exitCode,
              bodySnippet: input.body,
            });
          }
          status = "down";
        }
      }
    }
    data.status = status;

    await tx.heartbeatPing.create({
      data: {
        heartbeatId: id,
        kind: input.kind,
        exitCode: input.exitCode,
        durationMs,
        remoteIp: input.remoteIp,
        userAgent: input.userAgent ? input.userAgent.slice(0, USER_AGENT_MAX) : null,
        body: input.body,
        bodyTruncated: input.bodyTruncated,
        createdAt: now,
      },
    });
    const updated = await tx.heartbeat.update({ where: { id }, data, include: heartbeatInclude });
    return { hb: updated, alerts, durationMs };
  });

  if (!result) return null;
  for (const a of result.alerts) await emitHeartbeatAlert(result.hb as HeartbeatWithServer, a);
  return {
    heartbeatId: result.hb.id,
    status: result.hb.status,
    durationMs: result.durationMs,
    alerts: result.alerts.map((a) => a.kind),
  };
}
