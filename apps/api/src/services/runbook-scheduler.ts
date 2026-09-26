import {
  RunbookParamDefs,
  nextRunbookRun,
  resolveRunbookParamValues,
  type RunbookParamDef,
} from "@inv/shared";
import { prisma } from "../db.js";
import { writeAuditDirect } from "../lib/audit.js";
import { assertFeatureEnabled } from "./license.service.js";
import { kickRunbookWorker } from "./runbook-executor.service.js";
import { decodeScheduleParams, insertRun, sha256 } from "./runbook-run-factory.js";
import { parseStoredSelector, resolveTargets } from "./runbook-targets.js";

/**
 * Scheduled runbooks. Called every 30s by runbook-background.ts under the
 * `runbook:schedule` job lock, so one replica evaluates schedules at a time; the
 * compare-and-set on `nextScheduledAt` below makes a double tick harmless anyway.
 *
 * Policies:
 *  - Overlap: if the previous run of the same runbook is still waiting or
 *    running, this occurrence is skipped (never queued behind it).
 *  - Missed runs (API was down): an occurrence missed by less than one period is
 *    run once, late; anything older is skipped. Coming back from a weekend
 *    outage never fires a backlog of runs.
 *  - Scheduled runs never need approval: a runbook with requireApproval cannot
 *    have a schedule (validated on create/update).
 */

export type ScheduleSkipReason = "missed" | "overlap" | "license" | "invalid_schedule" | "params" | "targets";

export interface ScheduleTickResult {
  created: number[];
  skipped: { runbookId: number; reason: ScheduleSkipReason }[];
}

/** Next occurrence after `from`, or null when the expression cannot be evaluated. */
export function computeNextScheduledAt(schedule: string | null, timezone: string, from: Date): Date | null {
  if (!schedule?.trim()) return null;
  try {
    return nextRunbookRun(schedule, timezone, from);
  } catch {
    return null;
  }
}

export async function runRunbookScheduleTick(now: Date = new Date()): Promise<ScheduleTickResult> {
  const result: ScheduleTickResult = { created: [], skipped: [] };
  const due = await prisma.runbook.findMany({
    where: { scheduleEnabled: true, deletedAt: null, nextScheduledAt: { lte: now } },
    orderBy: { nextScheduledAt: "asc" },
    take: 50,
  });
  if (due.length === 0) return result;

  let licensed: boolean | null = null;

  for (const rb of due) {
    const seen = rb.nextScheduledAt!;
    const next = computeNextScheduledAt(rb.schedule, rb.scheduleTimezone, now);

    // Advance first, conditional on the value we read: exactly one tick (on any
    // replica) wins each occurrence, even if two ever overlap.
    const { count } = await prisma.runbook.updateMany({
      where: { id: rb.id, nextScheduledAt: seen },
      data: { nextScheduledAt: next },
    });
    if (count !== 1) continue;

    const skip = (reason: ScheduleSkipReason, detail: string) => {
      result.skipped.push({ runbookId: rb.id, reason });
      console.warn(`[runbooks] schedule: skipped "${rb.name}" (${reason}): ${detail}`);
    };

    if (!rb.schedule || next === null) {
      skip("invalid_schedule", "schedule cannot be evaluated; disable or fix it");
      continue;
    }
    const following = computeNextScheduledAt(rb.schedule, rb.scheduleTimezone, seen);
    if (following && now.getTime() >= following.getTime()) {
      skip("missed", `occurrence ${seen.toISOString()} is more than one period old`);
      continue;
    }

    const activeRuns = await prisma.runbookRun.count({
      where: { runbookId: rb.id, status: { in: ["pending_approval", "queued", "running"] } },
    });
    if (activeRuns > 0) {
      skip("overlap", "the previous run is still active");
      continue;
    }

    if (licensed === null) {
      licensed = await assertFeatureEnabled("runbooks").then(
        () => true,
        () => false,
      );
    }
    if (!licensed) {
      skip("license", "runbooks require a Pro or Enterprise license");
      continue;
    }

    const defsParsed = RunbookParamDefs.safeParse(rb.parameters);
    const stored = decodeScheduleParams(rb.scheduleParamsEnc);
    if (!defsParsed.success || stored === null) {
      skip("params", "stored parameters could not be read");
      continue;
    }
    const defs: RunbookParamDef[] = defsParsed.data;
    const { values, errors } = resolveRunbookParamValues(defs, stored);
    if (Object.keys(errors).length > 0) {
      skip("params", Object.entries(errors).map(([k, v]) => `${k} ${v}`).join("; "));
      continue;
    }

    let servers;
    try {
      const resolved = await resolveTargets(parseStoredSelector(rb.targetSelector));
      if (resolved.exceeded) {
        skip("targets", `selector matches more than ${resolved.maxTargets} servers`);
        continue;
      }
      servers = resolved.servers;
    } catch (err) {
      skip("targets", err instanceof Error ? err.message : "selector invalid");
      continue;
    }
    if (servers.length === 0) {
      skip("targets", "selector matches no servers");
      continue;
    }

    const runId = await insertRun({
      runbook: rb,
      servers,
      defs,
      values,
      triggeredBy: "schedule",
      requestedById: null,
      status: "queued",
      dryRun: false,
    });
    result.created.push(runId);

    await writeAuditDirect({
      ctx: { actorId: null, actorEmail: null, ip: null },
      category: "security",
      action: "runbook.run_scheduled",
      entity: "RunbookRun",
      entityId: String(runId),
      after: {
        runbookId: rb.id,
        runbookVersion: rb.version,
        scheduledFor: seen.toISOString(),
        scriptSha256: sha256(rb.script),
        targetServerIds: servers.map((s) => s.id),
        paramNames: Object.keys(values),
      },
    }).catch((err) => console.warn("[runbooks] audit write failed:", err));
  }

  if (result.created.length) kickRunbookWorker();
  return result;
}
