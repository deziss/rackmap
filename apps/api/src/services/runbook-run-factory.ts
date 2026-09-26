import { createHash } from "node:crypto";
import { z } from "zod";
import { RunbookParamDef, maskRunbookParamValues } from "@inv/shared";
import { prisma } from "../db.js";
import { decryptSecretDetailed, encryptSecret } from "../lib/crypto.js";

/**
 * Creating a RunbookRun: shared by the API routes (manual and API-key runs,
 * reruns) and the scheduler, so every path freezes the same snapshot.
 *
 * A run is a snapshot, not a pointer: script, interpreter, runAs, limits, the
 * parameter DEFINITIONS and the target list are copied at request time. Editing
 * the runbook afterwards never changes a queued or approved run — in particular,
 * an approver approves exactly the script they were shown.
 */

/** What paramsEnc decrypts to. Only the executor ever reads it. */
const RunParamsBlob = z.object({
  v: z.literal(1),
  defs: z.array(RunbookParamDef),
  values: z.record(z.string(), z.string()),
});
export type RunParamsBlob = z.infer<typeof RunParamsBlob>;

/**
 * v3 encryptSecret, never the vault: APP_ENCRYPTION_KEY is mandatory at boot, so
 * the background executor can always read this even while the vault is locked.
 */
export function encodeRunParams(defs: RunbookParamDef[], values: Record<string, string>): string {
  return encryptSecret(JSON.stringify({ v: 1, defs, values } satisfies RunParamsBlob));
}

export function decodeRunParams(blob: string | null): RunParamsBlob | null {
  if (!blob) return { v: 1, defs: [], values: {} };
  const dec = decryptSecretDetailed(blob);
  if (!dec.ok) return null;
  try {
    const parsed = RunParamsBlob.safeParse(JSON.parse(dec.plaintext));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Scheduled-run parameter values (Runbook.scheduleParamsEnc): a plain values map. */
export function encodeScheduleParams(values: Record<string, string>): string | null {
  return Object.keys(values).length ? encryptSecret(JSON.stringify(values)) : null;
}

export function decodeScheduleParams(blob: string | null): Record<string, string> | null {
  if (!blob) return {};
  const dec = decryptSecretDetailed(blob);
  if (!dec.ok) return null;
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(dec.plaintext));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface RunbookSnapshotSource {
  id: number;
  version: number;
  script: string;
  interpreter: string;
  runAs: string;
  timeoutSec: number;
  concurrency: number;
  maxFailures: number | null;
}

export interface InsertRunInput {
  runbook: RunbookSnapshotSource;
  servers: { id: number; hostname: string }[];
  defs: RunbookParamDef[];
  values: Record<string, string>;
  triggeredBy: "user" | "schedule" | "api";
  requestedById: string | null;
  status: "queued" | "pending_approval";
  dryRun: boolean;
}

/** Insert the run and one `pending` host row per target, atomically. Returns the run id. */
export async function insertRun(input: InsertRunInput): Promise<number> {
  const { runbook, servers } = input;
  return prisma.$transaction(async (tx) => {
    const run = await tx.runbookRun.create({
      data: {
        runbookId: runbook.id,
        runbookVersion: runbook.version,
        scriptSnapshot: runbook.script,
        interpreter: runbook.interpreter,
        runAs: runbook.runAs,
        timeoutSec: runbook.timeoutSec,
        concurrency: runbook.concurrency,
        maxFailures: runbook.maxFailures,
        params: maskRunbookParamValues(input.defs, input.values),
        paramsEnc: encodeRunParams(input.defs, input.values),
        targetServerIds: servers.map((s) => s.id),
        triggeredBy: input.triggeredBy,
        dryRun: input.dryRun,
        requestedById: input.requestedById,
        status: input.status,
      },
      select: { id: true },
    });
    await tx.runbookHostResult.createMany({
      data: servers.map((s) => ({ runId: run.id, serverId: s.id, hostname: s.hostname, status: "pending" })),
    });
    return run.id;
  });
}
