import type { Prisma } from "@prisma/client";
import {
  RunbookParamDefs,
  isRunbookRunActive,
  maskRunbookParamValues,
  resolveRunbookParamValues,
  runbookConfigIssues,
  type RunbookCreateInput,
  type RunbookDto,
  type RunbookHostOutputResponse,
  type RunbookHostResultDto,
  type RunbookParamDef,
  type RunbookPreviewTargetsInput,
  type RunbookRunDetailDto,
  type RunbookRunDto,
  type RunbookRunListQuery,
  type RunbookRunListResponse,
  type RunbookRunRequestInput,
  type RunbookRunStatus,
  type RunbookRunSummary,
  type RunbookTargetPreview,
  type RunbookUpdateInput,
  type RunbookUserRef,
} from "@inv/shared";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { writeAuditDirect, type AuditCtx } from "../../lib/audit.js";
import { AppError, conflict, forbidden, notFound } from "../../lib/errors.js";
import { can } from "../../lib/permissions.js";
import type { SessionUser } from "../../middleware/session.js";
import { emitAlert } from "../../services/alerting/emit.js";
import { assertFeatureEnabled } from "../../services/license.service.js";
import { kickRunbookWorker } from "../../services/runbook-executor.service.js";
import {
  decodeRunParams,
  decodeScheduleParams,
  encodeScheduleParams,
  insertRun,
  sha256,
} from "../../services/runbook-run-factory.js";
import { computeNextScheduledAt } from "../../services/runbook-scheduler.js";
import {
  everyTargetNeedsLockedVault,
  narrowTargets,
  parseStoredSelector,
  previewItems,
  resolveTargets,
} from "../../services/runbook-targets.js";

/**
 * Runbook business rules (blueprint §5.5):
 *
 *  - Authoring is admin-only (route guards): a runbook is arbitrary code that runs
 *    across the fleet, possibly as root.
 *  - Editors execute. A run goes straight to the queue only when it needs no
 *    second person: `requireApproval` is off AND (it runs as the SSH user, OR the
 *    caller can approve runs themselves). Everything else waits in
 *    `pending_approval`.
 *  - The approver must be a different person from the requester — including when
 *    the requester is an admin (four-eyes means four eyes).
 *  - Target overrides may only narrow the runbook's own target set.
 *  - Parameter NAMES are audited; values never are (they may be secrets).
 */

export interface Caller {
  user: SessionUser;
  viaApiKey: boolean;
  audit: AuditCtx;
}

function validationError(message: string, details?: unknown) {
  return new AppError("VALIDATION_ERROR", message, 400, details);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

const userRef = { select: { id: true, name: true, email: true } } as const;

function ref(u: { id: string; name: string; email: string } | null | undefined): RunbookUserRef | null {
  return u ? { id: u.id, name: u.name, email: u.email } : null;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function approvalTtlMs(): number {
  return env.RUNBOOK_APPROVAL_TTL_HOURS * 60 * 60 * 1000;
}

function parseDefs(raw: unknown): RunbookParamDef[] {
  const parsed = RunbookParamDefs.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

const runbookInclude = {
  createdBy: userRef,
  updatedBy: userRef,
  runs: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { id: true, status: true, dryRun: true, createdAt: true, finishedAt: true },
  },
} satisfies Prisma.RunbookInclude;

type RunbookRow = Prisma.RunbookGetPayload<{ include: typeof runbookInclude }>;

function toRunbookDto(rb: RunbookRow): RunbookDto {
  const defs = parseDefs(rb.parameters);
  const scheduleValues = decodeScheduleParams(rb.scheduleParamsEnc) ?? {};
  const last = rb.runs[0];
  return {
    id: rb.id,
    name: rb.name,
    description: rb.description,
    script: rb.script,
    interpreter: rb.interpreter === "sh" ? "sh" : "bash",
    parameters: defs,
    runAs: rb.runAs === "root" ? "root" : "sshUser",
    timeoutSec: rb.timeoutSec,
    concurrency: rb.concurrency,
    maxFailures: rb.maxFailures,
    requireApproval: rb.requireApproval,
    targetSelector: parseStoredSelector(rb.targetSelector),
    allowTargetOverride: rb.allowTargetOverride,
    schedule: rb.schedule,
    scheduleTimezone: rb.scheduleTimezone,
    scheduleEnabled: rb.scheduleEnabled,
    scheduleParams: maskRunbookParamValues(defs, scheduleValues),
    nextScheduledAt: iso(rb.nextScheduledAt),
    version: rb.version,
    createdBy: ref(rb.createdBy),
    updatedBy: ref(rb.updatedBy),
    createdAt: rb.createdAt.toISOString(),
    updatedAt: rb.updatedAt.toISOString(),
    lastRun: last
      ? {
          id: last.id,
          status: last.status as RunbookRunStatus,
          dryRun: last.dryRun,
          createdAt: last.createdAt.toISOString(),
          finishedAt: iso(last.finishedAt),
        }
      : null,
  };
}

const runInclude = {
  runbook: { select: { name: true } },
  requestedBy: userRef,
  approvedBy: userRef,
  rejectedBy: userRef,
  cancelledBy: userRef,
} satisfies Prisma.RunbookRunInclude;

type RunRow = Prisma.RunbookRunGetPayload<{ include: typeof runInclude }>;

function toRunDto(r: RunRow): RunbookRunDto {
  const params = (r.params && typeof r.params === "object" && !Array.isArray(r.params) ? r.params : {}) as unknown as Record<string, string>;
  const targets = Array.isArray(r.targetServerIds) ? (r.targetServerIds as unknown[]).filter((n): n is number => typeof n === "number") : [];
  return {
    id: r.id,
    runbookId: r.runbookId,
    runbookName: r.runbook.name,
    runbookVersion: r.runbookVersion,
    interpreter: r.interpreter === "sh" ? "sh" : "bash",
    runAs: r.runAs === "root" ? "root" : "sshUser",
    timeoutSec: r.timeoutSec,
    concurrency: r.concurrency,
    maxFailures: r.maxFailures,
    params,
    targetServerIds: targets,
    triggeredBy: r.triggeredBy === "schedule" || r.triggeredBy === "api" ? r.triggeredBy : "user",
    dryRun: r.dryRun,
    status: r.status as RunbookRunStatus,
    requestedBy: ref(r.requestedBy),
    approvedBy: ref(r.approvedBy),
    approvedAt: iso(r.approvedAt),
    rejectedBy: ref(r.rejectedBy),
    rejectionReason: r.rejectionReason,
    cancelRequestedAt: iso(r.cancelRequestedAt),
    cancelledBy: ref(r.cancelledBy),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    summary: (r.summary ?? null) as unknown as RunbookRunSummary | null,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    approvalExpiresAt: r.status === "pending_approval" ? new Date(r.createdAt.getTime() + approvalTtlMs()).toISOString() : null,
  };
}

// ─── Runbook CRUD ────────────────────────────────────────────────────────────

async function loadRunbook(id: number) {
  const rb = await prisma.runbook.findFirst({ where: { id, deletedAt: null }, include: runbookInclude });
  if (!rb) throw notFound("Runbook");
  return rb;
}

export async function listRunbooks(): Promise<RunbookDto[]> {
  const rows = await prisma.runbook.findMany({
    where: { deletedAt: null },
    include: runbookInclude,
    orderBy: { name: "asc" },
  });
  return rows.map(toRunbookDto);
}

export async function getRunbook(id: number): Promise<RunbookDto> {
  return toRunbookDto(await loadRunbook(id));
}

/**
 * Validate scheduled-run values. Missing required values only matter once the
 * schedule is enabled; unknown names and malformed values are always rejected.
 */
function resolveScheduleValues(defs: RunbookParamDef[], input: Record<string, unknown>, scheduleEnabled: boolean) {
  const { values, errors } = resolveRunbookParamValues(defs, input);
  const fatal = Object.fromEntries(Object.entries(errors).filter(([, msg]) => scheduleEnabled || msg !== "is required"));
  if (Object.keys(fatal).length) {
    throw validationError("Invalid scheduled-run parameters", { scheduleParams: fatal });
  }
  // Store only what was actually provided, not defaults: a later default change should apply.
  return Object.fromEntries(Object.entries(values).filter(([k]) => input[k] !== undefined && input[k] !== ""));
}

/** Audit-safe view of a runbook: the script is represented by its hash and size. */
function auditView(r: {
  name: string;
  script: string;
  interpreter: string;
  runAs: string;
  parameters: unknown;
  requireApproval: boolean;
  targetSelector: unknown;
  schedule: string | null;
  scheduleEnabled: boolean;
  timeoutSec: number;
  concurrency: number;
  maxFailures: number | null;
  version: number;
}) {
  return {
    name: r.name,
    scriptSha256: sha256(r.script),
    scriptBytes: Buffer.byteLength(r.script, "utf8"),
    interpreter: r.interpreter,
    runAs: r.runAs,
    parameterNames: parseDefs(r.parameters).map((d) => d.name),
    requireApproval: r.requireApproval,
    targetSelector: r.targetSelector,
    schedule: r.schedule,
    scheduleEnabled: r.scheduleEnabled,
    timeoutSec: r.timeoutSec,
    concurrency: r.concurrency,
    maxFailures: r.maxFailures,
    version: r.version,
  };
}

export async function createRunbook(input: RunbookCreateInput, caller: Caller): Promise<RunbookDto> {
  await assertFeatureEnabled("runbooks");

  const schedule = input.schedule?.trim() ? input.schedule.trim() : null;
  const scheduleValues = resolveScheduleValues(input.parameters, input.scheduleParams ?? {}, input.scheduleEnabled);
  const now = new Date();

  let created;
  try {
    created = await prisma.runbook.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        script: input.script,
        interpreter: input.interpreter,
        parameters: input.parameters as unknown as Prisma.InputJsonValue,
        runAs: input.runAs,
        timeoutSec: input.timeoutSec,
        concurrency: input.concurrency,
        maxFailures: input.maxFailures ?? null,
        requireApproval: input.requireApproval,
        targetSelector: input.targetSelector as unknown as Prisma.InputJsonValue,
        allowTargetOverride: input.allowTargetOverride,
        schedule,
        scheduleTimezone: input.scheduleTimezone,
        scheduleEnabled: input.scheduleEnabled,
        scheduleParamsEnc: encodeScheduleParams(scheduleValues),
        nextScheduledAt: input.scheduleEnabled ? computeNextScheduledAt(schedule, input.scheduleTimezone, now) : null,
        createdById: caller.user.id,
        updatedById: caller.user.id,
      },
      include: runbookInclude,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`A runbook named "${input.name}" already exists`);
    throw err;
  }

  await writeAuditDirect({
    ctx: caller.audit,
    category: "security",
    action: "runbook.create",
    entity: "Runbook",
    entityId: String(created.id),
    after: auditView(created),
  });
  return toRunbookDto(created);
}

export async function updateRunbook(id: number, input: RunbookUpdateInput, caller: Caller): Promise<RunbookDto> {
  const existing = await loadRunbook(id);

  const merged = {
    name: input.name ?? existing.name,
    description: input.description !== undefined ? input.description : existing.description,
    script: input.script ?? existing.script,
    interpreter: input.interpreter ?? existing.interpreter,
    parameters: input.parameters ?? parseDefs(existing.parameters),
    runAs: input.runAs ?? existing.runAs,
    timeoutSec: input.timeoutSec ?? existing.timeoutSec,
    concurrency: input.concurrency ?? existing.concurrency,
    maxFailures: input.maxFailures !== undefined ? input.maxFailures : existing.maxFailures,
    requireApproval: input.requireApproval ?? existing.requireApproval,
    targetSelector: input.targetSelector ?? parseStoredSelector(existing.targetSelector),
    allowTargetOverride: input.allowTargetOverride ?? existing.allowTargetOverride,
    schedule: input.schedule !== undefined ? (input.schedule?.trim() ? input.schedule.trim() : null) : existing.schedule,
    scheduleTimezone: input.scheduleTimezone ?? existing.scheduleTimezone,
    scheduleEnabled: input.scheduleEnabled ?? existing.scheduleEnabled,
  };

  const issues = runbookConfigIssues(merged);
  if (issues.length) throw validationError(issues[0]!.message, { issues });

  // Scheduled values: "***" for a secret means "keep the stored value" (the API
  // never returns secrets, so the form can only echo the mask back).
  const storedValues = decodeScheduleParams(existing.scheduleParamsEnc) ?? {};
  const secretNames = new Set(merged.parameters.filter((d) => d.type === "secret").map((d) => d.name));
  let scheduleInput: Record<string, unknown>;
  if (input.scheduleParams) {
    scheduleInput = Object.fromEntries(
      Object.entries(input.scheduleParams).map(([k, v]) => [k, v === "***" && secretNames.has(k) ? storedValues[k] : v]),
    );
  } else {
    // Parameters may have been removed or renamed: keep only values that still have a definition.
    const known = new Set(merged.parameters.map((d) => d.name));
    scheduleInput = Object.fromEntries(Object.entries(storedValues).filter(([k]) => known.has(k)));
  }
  const scheduleValues = resolveScheduleValues(merged.parameters, scheduleInput, merged.scheduleEnabled);

  // A new version whenever what runs changes; runs snapshot the version they used.
  const behaviourChanged =
    merged.script !== existing.script ||
    merged.interpreter !== existing.interpreter ||
    merged.runAs !== existing.runAs ||
    JSON.stringify(merged.parameters) !== JSON.stringify(parseDefs(existing.parameters));

  const scheduleChanged =
    merged.schedule !== existing.schedule ||
    merged.scheduleTimezone !== existing.scheduleTimezone ||
    merged.scheduleEnabled !== existing.scheduleEnabled;
  const nextScheduledAt = merged.scheduleEnabled
    ? scheduleChanged || !existing.nextScheduledAt
      ? computeNextScheduledAt(merged.schedule, merged.scheduleTimezone, new Date())
      : existing.nextScheduledAt
    : null;

  let updated;
  try {
    updated = await prisma.runbook.update({
      where: { id },
      data: {
        name: merged.name,
        description: merged.description,
        script: merged.script,
        interpreter: merged.interpreter,
        parameters: merged.parameters as unknown as Prisma.InputJsonValue,
        runAs: merged.runAs,
        timeoutSec: merged.timeoutSec,
        concurrency: merged.concurrency,
        maxFailures: merged.maxFailures,
        requireApproval: merged.requireApproval,
        targetSelector: merged.targetSelector as unknown as Prisma.InputJsonValue,
        allowTargetOverride: merged.allowTargetOverride,
        schedule: merged.schedule,
        scheduleTimezone: merged.scheduleTimezone,
        scheduleEnabled: merged.scheduleEnabled,
        scheduleParamsEnc: encodeScheduleParams(scheduleValues),
        nextScheduledAt,
        version: behaviourChanged ? { increment: 1 } : undefined,
        updatedById: caller.user.id,
      },
      include: runbookInclude,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`A runbook named "${merged.name}" already exists`);
    throw err;
  }

  await writeAuditDirect({
    ctx: caller.audit,
    category: "security",
    action: "runbook.update",
    entity: "Runbook",
    entityId: String(id),
    before: auditView(existing),
    after: auditView(updated),
  });
  return toRunbookDto(updated);
}

/**
 * Soft delete: runs reference the runbook (Restrict), and their history must
 * survive. The name gets a suffix so it can be reused, the schedule stops, and
 * runs that have not started yet are cancelled.
 */
export async function deleteRunbook(id: number, caller: Caller): Promise<void> {
  const existing = await loadRunbook(id);
  const now = new Date();
  const suffix = `~deleted-${id}`;
  await prisma.$transaction(async (tx) => {
    await tx.runbook.update({
      where: { id },
      data: {
        deletedAt: now,
        name: `${existing.name.slice(0, 200 - suffix.length)}${suffix}`,
        scheduleEnabled: false,
        nextScheduledAt: null,
        updatedById: caller.user.id,
      },
    });
    const waiting = await tx.runbookRun.findMany({
      where: { runbookId: id, status: { in: ["pending_approval", "queued"] } },
      select: { id: true },
    });
    if (waiting.length) {
      const ids = waiting.map((r) => r.id);
      await tx.runbookRun.updateMany({
        where: { id: { in: ids }, status: { in: ["pending_approval", "queued"] } },
        data: { status: "cancelled", finishedAt: now, cancelRequestedAt: now, cancelledById: caller.user.id, error: "Runbook deleted" },
      });
      await tx.runbookHostResult.updateMany({
        where: { runId: { in: ids }, status: "pending" },
        data: { status: "cancelled", errorCode: "CANCELLED", finishedAt: now },
      });
    }
  });

  await writeAuditDirect({
    ctx: caller.audit,
    category: "security",
    action: "runbook.delete",
    entity: "Runbook",
    entityId: String(id),
    before: auditView(existing),
  });
}

// ─── Targets and run requests ────────────────────────────────────────────────

function needsApproval(rb: { requireApproval: boolean; runAs: string }, user: SessionUser, dryRun: boolean): boolean {
  if (dryRun) return false;
  if (rb.requireApproval) return true;
  return rb.runAs === "root" && !can(user.role, "runbook", "approve");
}

function needsConfirmation(runAs: string, targets: { environment: string | null }[]): boolean {
  return runAs === "root" || targets.length > 10 || targets.some((t) => t.environment?.toLowerCase() === "production");
}

async function resolveForRun(rb: { targetSelector: unknown; allowTargetOverride: boolean }, override: number[] | undefined, opts: { allowOverride: boolean }) {
  const resolved = await resolveTargets(parseStoredSelector(rb.targetSelector));
  if (resolved.exceeded) {
    throw validationError(`The selector matches more than ${resolved.maxTargets} servers (RUNBOOK_MAX_TARGETS). Narrow it first.`);
  }
  if (override && !rb.allowTargetOverride && !opts.allowOverride) {
    throw forbidden("This runbook does not allow choosing targets at run time");
  }
  const servers = narrowTargets(resolved.servers, override);
  return { servers, resolved };
}

export async function previewRunbookTargets(id: number, input: RunbookPreviewTargetsInput, user: SessionUser): Promise<RunbookTargetPreview> {
  const rb = await loadRunbook(id);
  const { servers, resolved } = await resolveForRun(rb, input.targets?.serverIds, { allowOverride: false });
  return {
    targets: previewItems(servers),
    total: servers.length,
    exceeded: resolved.exceeded,
    maxTargets: resolved.maxTargets,
    requiresApproval: needsApproval(rb, user, false),
    requiresConfirmation: needsConfirmation(rb.runAs, servers),
  };
}

export async function requestRun(
  runbookId: number,
  input: RunbookRunRequestInput,
  caller: Caller,
  opts: { rerunOf?: number } = {},
): Promise<RunbookRunDto> {
  await assertFeatureEnabled("runbooks");
  const rb = await loadRunbook(runbookId);
  const defs = parseDefs(rb.parameters);

  // A dry run only runs the fixed probe, so it needs no parameter values.
  let values: Record<string, string> = {};
  if (!input.dryRun) {
    // A rerun carries the original run's values; drop any the runbook no longer defines.
    const known = new Set(defs.map((d) => d.name));
    const provided = opts.rerunOf !== undefined
      ? Object.fromEntries(Object.entries(input.params).filter(([k]) => known.has(k)))
      : input.params;
    const resolvedParams = resolveRunbookParamValues(defs, provided);
    if (Object.keys(resolvedParams.errors).length) {
      throw validationError("Invalid parameters", { params: resolvedParams.errors });
    }
    values = resolvedParams.values;
  }

  const { servers } = await resolveForRun(rb, input.targets?.serverIds, { allowOverride: opts.rerunOf !== undefined });
  if (servers.length === 0) throw validationError("The runbook's selector matches no servers");

  if (everyTargetNeedsLockedVault(servers, { asRoot: rb.runAs === "root" && !input.dryRun })) {
    throw new AppError(
      "VAULT_LOCKED",
      "Every target needs its vault-encrypted password and the vault is locked for background jobs. Set VAULT_PASSPHRASE or unlock the vault globally.",
      409,
    );
  }

  const status = needsApproval(rb, caller.user, input.dryRun) ? "pending_approval" : "queued";
  const triggeredBy = caller.viaApiKey ? "api" : "user";
  const runId = await insertRun({
    runbook: rb,
    servers,
    defs: input.dryRun ? [] : defs,
    values,
    triggeredBy,
    requestedById: caller.user.id,
    status,
    dryRun: input.dryRun,
  });

  await writeAuditDirect({
    ctx: caller.audit,
    category: "security",
    action: "runbook.run_request",
    entity: "RunbookRun",
    entityId: String(runId),
    after: {
      runbookId: rb.id,
      runbookName: rb.name,
      runbookVersion: rb.version,
      scriptSha256: sha256(rb.script),
      runAs: rb.runAs,
      targetServerIds: servers.map((s) => s.id),
      paramNames: Object.keys(values),
      dryRun: input.dryRun,
      status,
      triggeredBy,
      ...(opts.rerunOf !== undefined ? { rerunOf: opts.rerunOf } : {}),
    },
  });

  if (status === "queued") {
    kickRunbookWorker();
  } else {
    await emitAlert({
      type: "runbook_approval",
      severity: "info",
      action: "info",
      title: `Runbook "${rb.name}" is waiting for approval`,
      summary: `${caller.user.name || caller.user.email} requested a run on ${servers.length} host(s)${rb.runAs === "root" ? " as root" : ""}.`,
      payload: { runId, runbookId: rb.id, requestedBy: caller.user.email },
      runbookRunId: runId,
    }).catch((err) => console.warn("[runbooks] approval alert failed:", err));
  }

  return getRunDto(runId);
}

// ─── Runs ────────────────────────────────────────────────────────────────────

async function getRunDto(id: number): Promise<RunbookRunDto> {
  const run = await prisma.runbookRun.findUnique({ where: { id }, include: runInclude });
  if (!run) throw notFound("Run");
  return toRunDto(run);
}

export async function listRuns(q: RunbookRunListQuery): Promise<RunbookRunListResponse> {
  const rows = await prisma.runbookRun.findMany({
    where: {
      ...(q.runbookId ? { runbookId: q.runbookId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.cursor ? { id: { lt: q.cursor } } : {}),
    },
    include: runInclude,
    orderBy: { id: "desc" },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  return { items: page.map(toRunDto), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
}

export async function pendingApprovalCount(): Promise<number> {
  return prisma.runbookRun.count({
    where: { status: "pending_approval", createdAt: { gte: new Date(Date.now() - approvalTtlMs()) } },
  });
}

export async function getRunDetail(id: number): Promise<RunbookRunDetailDto> {
  const run = await prisma.runbookRun.findUnique({
    where: { id },
    include: { ...runInclude, runbook: { select: { name: true, version: true, script: true, deletedAt: true } } },
  });
  if (!run) throw notFound("Run");

  const hosts = await prisma.runbookHostResult.findMany({
    where: { runId: id },
    orderBy: { id: "asc" },
    select: {
      id: true,
      serverId: true,
      hostname: true,
      status: true,
      errorCode: true,
      exitCode: true,
      stdoutTruncated: true,
      stderrTruncated: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
    },
  });
  // Output sizes without shipping the output itself.
  const lengths = await prisma.$queryRaw<{ id: number; stdoutLength: number; stderrLength: number }[]>`
    SELECT "id", length("stdout")::int AS "stdoutLength", length("stderr")::int AS "stderrLength"
    FROM runbook_host_result WHERE "runId" = ${id}`;
  const byId = new Map(lengths.map((l) => [l.id, l]));

  const hostDtos: RunbookHostResultDto[] = hosts.map((h) => ({
    id: h.id,
    serverId: h.serverId,
    hostname: h.hostname,
    status: h.status as RunbookHostResultDto["status"],
    errorCode: h.errorCode,
    exitCode: h.exitCode,
    stdoutLength: byId.get(h.id)?.stdoutLength ?? 0,
    stderrLength: byId.get(h.id)?.stderrLength ?? 0,
    stdoutTruncated: h.stdoutTruncated,
    stderrTruncated: h.stderrTruncated,
    startedAt: iso(h.startedAt),
    finishedAt: iso(h.finishedAt),
    durationMs: h.durationMs,
  }));

  const changed = run.runbook.version !== run.runbookVersion && !run.runbook.deletedAt;
  return {
    ...toRunDto(run),
    scriptSnapshot: run.scriptSnapshot,
    hosts: hostDtos,
    currentVersion: changed ? run.runbook.version : null,
    currentScript: changed && run.runbook.script !== run.scriptSnapshot ? run.runbook.script : null,
  };
}

/** Characters per stream per call; ≤64 KB of text per response for typical output. */
export const OUTPUT_CHUNK_CHARS = 32_768;

/** Code points, the unit Postgres substr()/length() count in (JS .length counts UTF-16 units). */
function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export async function getHostOutput(
  runId: number,
  serverId: number,
  from: { stdoutFrom: number; stderrFrom: number },
): Promise<RunbookHostOutputResponse> {
  const rows = await prisma.$queryRaw<
    {
      status: string;
      stdout: string;
      stderr: string;
      stdoutLength: number;
      stderrLength: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
    }[]
  >`
    SELECT "status",
           substr("stdout", ${from.stdoutFrom + 1}::int, ${OUTPUT_CHUNK_CHARS}::int) AS "stdout",
           substr("stderr", ${from.stderrFrom + 1}::int, ${OUTPUT_CHUNK_CHARS}::int) AS "stderr",
           length("stdout")::int AS "stdoutLength",
           length("stderr")::int AS "stderrLength",
           "stdoutTruncated", "stderrTruncated"
    FROM runbook_host_result
    WHERE "runId" = ${runId} AND "serverId" = ${serverId}
    LIMIT 1`;
  const row = rows[0];
  if (!row) throw notFound("Host result");

  const stdoutNext = Math.min(row.stdoutLength, from.stdoutFrom + codePoints(row.stdout));
  const stderrNext = Math.min(row.stderrLength, from.stderrFrom + codePoints(row.stderr));
  const finished = row.status !== "pending" && row.status !== "running";
  return {
    status: row.status as RunbookHostOutputResponse["status"],
    stdout: row.stdout,
    stderr: row.stderr,
    stdoutNext,
    stderrNext,
    stdoutLength: row.stdoutLength,
    stderrLength: row.stderrLength,
    stdoutTruncated: row.stdoutTruncated,
    stderrTruncated: row.stderrTruncated,
    done: finished && stdoutNext >= row.stdoutLength && stderrNext >= row.stderrLength,
  };
}

async function loadRunForAction(id: number) {
  const run = await prisma.runbookRun.findUnique({
    where: { id },
    select: { id: true, status: true, requestedById: true, createdAt: true, runbookId: true, cancelRequestedAt: true },
  });
  if (!run) throw notFound("Run");
  return run;
}

export async function approveRun(id: number, caller: Caller): Promise<RunbookRunDto> {
  const run = await loadRunForAction(id);
  if (run.status !== "pending_approval") throw conflict(`Run is ${run.status}, not waiting for approval`);
  if (run.requestedById === caller.user.id) {
    throw new AppError("SELF_APPROVAL", "You cannot approve your own run. Another admin must approve it.", 403);
  }
  const now = new Date();
  if (now.getTime() - run.createdAt.getTime() > approvalTtlMs()) {
    await prisma.runbookRun.updateMany({
      where: { id, status: "pending_approval" },
      data: { status: "expired", finishedAt: now, error: "Not approved in time" },
    });
    await prisma.runbookHostResult.updateMany({ where: { runId: id, status: "pending" }, data: { status: "skipped", finishedAt: now } });
    throw conflict("The approval window for this run has expired");
  }
  await assertFeatureEnabled("runbooks");

  const { count } = await prisma.runbookRun.updateMany({
    where: { id, status: "pending_approval" },
    data: { status: "queued", approvedById: caller.user.id, approvedAt: now },
  });
  if (count !== 1) throw conflict("Run is no longer waiting for approval");

  await writeAuditDirect({
    ctx: caller.audit,
    category: "security",
    action: "runbook.run_approve",
    entity: "RunbookRun",
    entityId: String(id),
    after: { runbookId: run.runbookId, requestedById: run.requestedById },
  });
  kickRunbookWorker();
  return getRunDto(id);
}

export async function rejectRun(id: number, reason: string | undefined, caller: Caller): Promise<RunbookRunDto> {
  const run = await loadRunForAction(id);
  if (run.status !== "pending_approval") throw conflict(`Run is ${run.status}, not waiting for approval`);
  const now = new Date();
  const { count } = await prisma.runbookRun.updateMany({
    where: { id, status: "pending_approval" },
    data: { status: "rejected", rejectedById: caller.user.id, rejectionReason: reason || null, finishedAt: now },
  });
  if (count !== 1) throw conflict("Run is no longer waiting for approval");
  await prisma.runbookHostResult.updateMany({ where: { runId: id, status: "pending" }, data: { status: "skipped", finishedAt: now } });

  await writeAuditDirect({
    ctx: caller.audit,
    category: "security",
    action: "runbook.run_reject",
    entity: "RunbookRun",
    entityId: String(id),
    after: { runbookId: run.runbookId, requestedById: run.requestedById, reason: reason ?? null },
  });
  return getRunDto(id);
}

export async function cancelRun(id: number, caller: Caller): Promise<RunbookRunDto> {
  const run = await loadRunForAction(id);
  if (run.requestedById !== caller.user.id && !can(caller.user.role, "runbook", "approve")) {
    throw forbidden("Only the requester or an admin can cancel this run");
  }
  const now = new Date();
  if (run.status === "pending_approval" || run.status === "queued") {
    const { count } = await prisma.runbookRun.updateMany({
      where: { id, status: { in: ["pending_approval", "queued"] } },
      data: { status: "cancelled", cancelRequestedAt: now, cancelledById: caller.user.id, finishedAt: now },
    });
    if (count !== 1) throw conflict("Run already started or finished; reload and try again");
    await prisma.runbookHostResult.updateMany({
      where: { runId: id, status: "pending" },
      data: { status: "cancelled", errorCode: "CANCELLED", finishedAt: now },
    });
  } else if (run.status === "running") {
    // The executor notices within a couple of seconds, aborts its hosts (remote
    // pkill) and finalises the run as cancelled.
    if (!run.cancelRequestedAt) {
      await prisma.runbookRun.updateMany({
        where: { id, status: "running", cancelRequestedAt: null },
        data: { cancelRequestedAt: now, cancelledById: caller.user.id },
      });
    }
  } else {
    throw conflict(`Run is already ${run.status}`);
  }

  await writeAuditDirect({
    ctx: caller.audit,
    category: "security",
    action: "runbook.run_cancel",
    entity: "RunbookRun",
    entityId: String(id),
    after: { runbookId: run.runbookId, previousStatus: run.status },
  });
  return getRunDto(id);
}

/**
 * Run again with the same parameters, against the same hosts or only those that
 * did not succeed. Goes through requestRun, so it is re-licensed, re-validated
 * against the CURRENT runbook, and re-evaluated for approval.
 */
export async function rerunRun(id: number, onlyFailed: boolean, caller: Caller): Promise<RunbookRunDto> {
  const orig = await prisma.runbookRun.findUnique({
    where: { id },
    select: {
      id: true,
      runbookId: true,
      status: true,
      dryRun: true,
      paramsEnc: true,
      targetServerIds: true,
      hostResults: { select: { serverId: true, status: true } },
    },
  });
  if (!orig) throw notFound("Run");
  if (isRunbookRunActive(orig.status)) throw conflict("The run is still active");

  const serverIds = onlyFailed
    ? orig.hostResults.filter((h) => h.status !== "succeeded" && h.serverId !== null).map((h) => h.serverId as number)
    : (Array.isArray(orig.targetServerIds) ? (orig.targetServerIds as unknown[]) : []).filter((n): n is number => typeof n === "number");
  if (serverIds.length === 0) {
    throw validationError(onlyFailed ? "Every host succeeded; nothing to rerun" : "The run has no targets");
  }

  const params = orig.dryRun ? { values: {} } : decodeRunParams(orig.paramsEnc);
  if (!params) throw conflict("The original run's parameters can no longer be decrypted");

  return requestRun(
    orig.runbookId,
    { params: params.values, targets: { serverIds }, dryRun: orig.dryRun },
    caller,
    { rerunOf: orig.id },
  );
}
