import { Prisma } from "@prisma/client";
import {
  HEARTBEAT_MAX_CRON_LINE,
  HeartbeatWrapError,
  formatCronEntry,
  parseCrontab,
  serializeCrontab,
  splitCronCommandRaw,
  unwrapHeartbeatCommand,
  validateCronSchedule,
  wrapCommandForHeartbeat,
  isValidHeartbeatTimeZone,
  normalizeHeartbeatSchedule,
  type CronEntryLine,
  type CronKind,
  type CronLine,
  type CronTarget,
  type HeartbeatCronSource,
  type HeartbeatMonitorInput,
  type HeartbeatMonitorResponse,
  type HeartbeatUnmonitorInput,
  type HeartbeatUnmonitorResponse,
} from "@inv/shared";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { can } from "../lib/permissions.js";
import { writeAuditDirect, type AuditCtx } from "../lib/audit.js";
import { cronErrorToHttp, cronTargetLabel, readCronTarget, writeCronTarget } from "./cron.service.js";
import { RemoteExecError } from "./remote-exec.service.js";
import { SshError } from "./ssh.service.js";
import { computeInitial, assertSchedulable } from "./heartbeat-schedule.js";
import {
  PUBLIC_BASE_URL_WARNING,
  buildPingUrl,
  generateHeartbeatToken,
  getPublicBaseUrl,
  hashHeartbeatToken,
  heartbeatInclude,
  parseCronSource,
  toHeartbeatDto,
  type HeartbeatWithServer,
} from "./heartbeat.service.js";

/**
 * "Monitor this job": link a crontab entry to a heartbeat by rewriting its command
 * so every run pings RackMap with its exit code — and the reverse.
 *
 * Crontabs are read and written ONLY through the cron service's compare-and-set
 * contract: the client's `baseHash` must still match the host, and the write is
 * conditional on the hash we just read. The heartbeat row is created first (the
 * line needs its id and token) and deleted again if the write provably failed, so
 * a half-done monitor never leaves a heartbeat that nothing pings. A failure that
 * does not say whether the host installed the file is settled by reading it back.
 *
 * The `# rackmap: … hb=<id>` marker and the wrapped token are text on the host,
 * under the control of anyone who can edit that crontab. A heartbeat is acted on
 * only when it is linked to this very server and target.
 */

export interface CronMonitorCtx {
  role: string;
  audit: AuditCtx;
  overridePassword?: string;
}

/**
 * A crontab write failed without saying whether the host installed the new file
 * (a timeout, or output cut off after `crontab -u` had run), and reading the
 * target back failed too. Nothing was rolled back: the new line may be live.
 */
export class CronWriteUnconfirmedError extends Error {
  constructor(
    message: string,
    readonly heartbeatId: number,
  ) {
    super(message);
    this.name = "CronWriteUnconfirmedError";
  }
}

const LABEL_MAX = 80;
/** hb=<id> allows ten digits; ids beyond int4 cannot exist and would fail the lookup. */
const MAX_HEARTBEAT_ID = 2_147_483_647;

function cronKindOf(target: CronTarget): CronKind {
  return target.kind === "user" ? "user" : "system";
}

function sameCronTarget(a: CronTarget, b: CronTarget): boolean {
  if (a.kind === "user") return b.kind === "user" && a.user === b.user;
  if (a.kind === "crond") return b.kind === "crond" && a.file === b.file;
  return b.kind === "system";
}

function lineTokenHash(command: string): string | null {
  const u = unwrapHeartbeatCommand(command);
  return u ? hashHeartbeatToken(u.token) : null;
}

/**
 * The heartbeat a crontab line points at — by its token first (a secret), then by
 * its marker — but only if that heartbeat is linked to `target` on `serverId`. A
 * copied or hand-typed marker must not pause another server's heartbeat, or pull
 * its stored command onto this host.
 */
async function findLinkedHeartbeat(
  entry: CronEntryLine,
  serverId: number,
  target: CronTarget,
): Promise<{ hb: HeartbeatWithServer; source: HeartbeatCronSource } | null> {
  const lookups: Prisma.HeartbeatWhereUniqueInput[] = [];
  const tokenHash = lineTokenHash(entry.command);
  if (tokenHash) lookups.push({ tokenHash });
  if (entry.heartbeatId !== undefined && entry.heartbeatId <= MAX_HEARTBEAT_ID) lookups.push({ id: entry.heartbeatId });
  for (const where of lookups) {
    const hb = await prisma.heartbeat.findUnique({ where, include: heartbeatInclude });
    if (!hb || hb.serverId !== serverId) continue;
    const source = parseCronSource(hb.cronSource);
    if (source && sameCronTarget(source.target, target)) return { hb, source };
  }
  return null;
}

/** Errors that prove writeCronTarget left the host's crontab as it was. */
function writeProvablyFailed(err: unknown): boolean {
  // AppError: a check before the write, the host script's CONFLICT/FAILED verdict,
  // or sudo refusing to start it. SshError: the connection never came up.
  if (err instanceof AppError || err instanceof SshError) return true;
  // The script never started. A TIMEOUT (or cancel) may land after `crontab -u` ran.
  return err instanceof RemoteExecError && err.code !== "TIMEOUT" && err.code !== "CANCELLED";
}

type CronWriteOutcome = { ok: true; hash: string } | { ok: false; error: unknown; unconfirmed: boolean };

/**
 * writeCronTarget, where an ambiguous failure (timeout, incomplete output, …) is
 * settled by reading the target back: `ok` if `isLive` finds the new line there,
 * a plain failure if it is absent, `unconfirmed` if the read-back failed as well.
 */
async function writeCronOrConfirm(
  serverId: number,
  target: CronTarget,
  content: string,
  baseHash: string,
  ctx: CronMonitorCtx,
  isLive: (lines: CronLine[]) => boolean,
): Promise<CronWriteOutcome> {
  try {
    const { hash } = await writeCronTarget(serverId, { target, content, baseHash }, ctx.audit, {
      overridePassword: ctx.overridePassword,
      canSudo: can(ctx.role, "server", "sudo"),
    });
    return { ok: true, hash };
  } catch (error) {
    if (writeProvablyFailed(error)) return { ok: false, error, unconfirmed: false };
    let after: Awaited<ReturnType<typeof readCronTarget>>;
    try {
      after = await readCronTarget(serverId, target, { overridePassword: ctx.overridePassword });
    } catch (readErr) {
      console.error(`[heartbeat] could not read ${cronTargetLabel(target)} back on server ${serverId} after a failed write:`, readErr);
      return { ok: false, error, unconfirmed: true };
    }
    if (isLive(parseCrontab(after.content, cronKindOf(target)))) {
      console.warn(`[heartbeat] the write of ${cronTargetLabel(target)} on server ${serverId} reported an error but the new line is live:`, error);
      return { ok: true, hash: after.hash };
    }
    return { ok: false, error, unconfirmed: false };
  }
}

function hasTokenLine(lines: CronLine[], tokenHash: string): boolean {
  return lines.some((l) => l.type === "entry" && lineTokenHash(l.command) === tokenHash);
}

/** Root's crontab, /etc/crontab and cron.d run as root: editing them is root-equivalent. */
export function cronTargetNeedsSudo(target: CronTarget): boolean {
  return target.kind !== "user" || target.user === "root";
}

function assertCronAccess(role: string, target: CronTarget, privileged: boolean): void {
  if (!can(role, "server", "cron")) {
    throw new AppError("FORBIDDEN", "Insufficient permissions", 403);
  }
  if ((cronTargetNeedsSudo(target) || privileged) && !can(role, "server", "sudo")) {
    throw new AppError(
      "FORBIDDEN",
      privileged
        ? "This user is root-equivalent (sudo/wheel/docker group or a sudoers rule); editing their crontab requires the server:sudo permission"
        : "Editing root, /etc/crontab or /etc/cron.d requires the server:sudo permission",
      403,
    );
  }
}

function requirePingBase(): string {
  const base = getPublicBaseUrl();
  if (!base) throw new AppError("PUBLIC_BASE_URL_UNSET", PUBLIC_BASE_URL_WARNING, 409);
  return base;
}

function findEntry(lines: CronLine[], lineNo: number): { entry: CronEntryLine; index: number } {
  const index = lines.findIndex((l) => l.lineNo === lineNo);
  const line = index >= 0 ? lines[index] : undefined;
  if (!line || line.type !== "entry") {
    throw new AppError("VALIDATION_ERROR", `Line ${lineNo} is not a cron job`, 400);
  }
  return { entry: line, index };
}

/** CRON_TZ (cronie) applies to the entries after it; otherwise the host's zone. */
function effectiveTimezone(lines: CronLine[], index: number, hostTz: string): string {
  let tz: string | null = null;
  for (let i = 0; i < index; i++) {
    const l = lines[i]!;
    if (l.type === "env" && l.name === "CRON_TZ") tz = l.value.trim();
  }
  if (tz && isValidHeartbeatTimeZone(tz)) return tz;
  return isValidHeartbeatTimeZone(hostTz) ? hostTz : "UTC";
}

function cleanLabel(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(?:^|\s)hb=[0-9]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LABEL_MAX);
}

/** Default label: the command's first words, e.g. "/usr/local/bin/backup.sh --full". */
function deriveLabel(entry: CronEntryLine): string {
  const label = cleanLabel(splitCronCommandRaw(entry.command).cmdPart);
  return label || `line ${entry.lineNo}`;
}

function wrapError(err: unknown): never {
  if (err instanceof HeartbeatWrapError) throw new AppError("VALIDATION_ERROR", err.message, 400);
  throw err;
}

async function readTarget(serverId: number, target: CronTarget, ctx: CronMonitorCtx, baseHash?: string) {
  const snapshot = await readCronTarget(serverId, target, { overridePassword: ctx.overridePassword });
  // Re-checked on the host on every write path: a user may have been added to the
  // sudo group since the editor was loaded.
  assertCronAccess(ctx.role, target, snapshot.privileged);
  if (baseHash !== undefined && snapshot.hash !== baseHash) {
    throw new AppError(
      "CRON_CONFLICT",
      "The crontab was changed on the host since it was loaded. Reload it and try again.",
      409,
    );
  }
  return snapshot;
}

async function assertServer(serverId: number): Promise<void> {
  const server = await prisma.server.findFirst({ where: { id: serverId, deletedAt: null }, select: { id: true } });
  if (!server) throw new AppError("NOT_FOUND", "Server not found", 404);
}

export async function monitorCronEntry(
  serverId: number,
  input: HeartbeatMonitorInput,
  ctx: CronMonitorCtx,
): Promise<HeartbeatMonitorResponse> {
  assertCronAccess(ctx.role, input.target, false);
  const pingBase = requirePingBase();
  await assertServer(serverId);

  const snapshot = await readTarget(serverId, input.target, ctx, input.baseHash);
  const kind = cronKindOf(input.target);
  const lines = parseCrontab(snapshot.content, kind);
  const { entry, index } = findEntry(lines, input.lineNo);

  if (entry.disabled) {
    throw new AppError("VALIDATION_ERROR", "Enable this cron job before monitoring it — a disabled job never runs", 400);
  }
  // A marker without a wrapper counts only if it names a heartbeat linked to this
  // target; a stale or copied one is simply replaced by the new heartbeat's id.
  if (unwrapHeartbeatCommand(entry.command) || (entry.heartbeatId !== undefined && (await findLinkedHeartbeat(entry, serverId, input.target)))) {
    throw new AppError("CONFLICT", "This cron job is already monitored by a heartbeat", 409);
  }
  const vixie = validateCronSchedule(entry.schedule);
  if (!vixie.ok) throw new AppError("VALIDATION_ERROR", vixie.error, 400);
  const norm = normalizeHeartbeatSchedule(entry.schedule);
  if (!norm.ok) throw new AppError("VALIDATION_ERROR", norm.error, 400);

  const timezone = effectiveTimezone(lines, index, snapshot.timezone);
  try {
    assertSchedulable(entry.schedule, timezone);
  } catch (err) {
    throw new AppError("VALIDATION_ERROR", err instanceof Error ? err.message : "Invalid schedule", 400);
  }

  const label = (input.name ? cleanLabel(input.name) : "") || entry.label || deriveLabel(entry);
  const name = input.name ?? label;
  const tok = generateHeartbeatToken();

  // Fail before touching anything if the wrapped line cannot fit.
  let wrapped: string;
  try {
    wrapped = wrapCommandForHeartbeat({ command: entry.command, pingBase, token: tok.token, measureDuration: input.measureDuration });
  } catch (err) {
    wrapError(err);
  }
  const newLine = formatCronEntry({ schedule: entry.schedule, user: entry.user, command: wrapped, disabled: false }, kind);
  if (newLine.length > HEARTBEAT_MAX_CRON_LINE) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The monitored line would be ${newLine.length} characters; cron truncates lines longer than about ${HEARTBEAT_MAX_CRON_LINE}. ` +
        "Move the command into a script and schedule the script instead.",
      400,
    );
  }

  const cronSource: HeartbeatCronSource = {
    target: input.target,
    originalCommand: entry.command,
    label,
    labelLineInserted: entry.label === undefined,
  };
  const fields = {
    kind: "cron",
    schedule: entry.schedule,
    timezone,
    periodSeconds: null,
    graceSeconds: input.graceSeconds,
    maxRuntimeSeconds: null,
  };
  const now = new Date();
  // The job is already scheduled on the host, so the first run is expected now.
  const deadlines = computeInitial(fields, now, true);

  const created = await prisma.heartbeat.create({
    data: {
      name,
      serverId,
      ...fields,
      notifyOnLate: input.notifyOnLate ?? false,
      tokenHash: tok.tokenHash,
      tokenEnc: tok.tokenEnc,
      tokenPrefix: tok.tokenPrefix,
      status: "new",
      expectedAt: deadlines.expectedAt,
      alertAt: deadlines.alertAt,
      cronSource: cronSource as unknown as Prisma.InputJsonValue,
      createdById: ctx.audit.actorId ?? null,
    },
    include: heartbeatInclude,
  });

  const updatedLines = lines.slice();
  updatedLines[index] = { ...entry, command: wrapped, label, heartbeatId: created.id };

  const outcome = await writeCronOrConfirm(
    serverId,
    input.target,
    serializeCrontab(updatedLines),
    snapshot.hash,
    ctx,
    (after) => hasTokenLine(after, tok.tokenHash),
  );
  if (!outcome.ok && !outcome.unconfirmed) {
    // Nothing on the host pings this heartbeat — do not leave it behind to go "down".
    await prisma.heartbeat.delete({ where: { id: created.id } }).catch((e) => {
      console.error(`[heartbeat] could not remove heartbeat ${created.id} after a failed crontab write:`, e);
    });
    throw outcome.error;
  }

  const audit = async (unconfirmed: boolean) => {
    await writeAuditDirect({
      ctx: ctx.audit,
      category: "data",
      action: "server.cron_monitor",
      entity: "Server",
      entityId: String(serverId),
      after: {
        target: input.target,
        lineNo: input.lineNo,
        heartbeatId: created.id,
        schedule: entry.schedule,
        timezone,
        graceSeconds: input.graceSeconds,
        measureDuration: input.measureDuration,
        ...(unconfirmed ? { unconfirmed: true } : {}),
      },
    });
    await writeAuditDirect({
      ctx: ctx.audit,
      category: "data",
      action: "heartbeat.create",
      entity: "Heartbeat",
      entityId: String(created.id),
      after: { name, kind: "cron", schedule: entry.schedule, timezone, serverId, source: "cron_monitor" },
    });
  };

  if (!outcome.ok) {
    // The host may already run the wrapped line: keep the heartbeat (still "new").
    await audit(true);
    throw new CronWriteUnconfirmedError(
      `Could not confirm that ${cronTargetLabel(input.target)} was updated on the host (${cronErrorToHttp(outcome.error).message}). ` +
        `Heartbeat ${created.id} was kept in case the monitored line is live: check the crontab, and if the line is not monitored, delete the heartbeat and try again.`,
      created.id,
    );
  }

  await audit(false);
  return { heartbeat: toHeartbeatDto(created), hash: outcome.hash, pingUrl: buildPingUrl(tok.token) };
}

export async function unmonitorCronEntry(
  serverId: number,
  input: HeartbeatUnmonitorInput,
  ctx: CronMonitorCtx,
): Promise<HeartbeatUnmonitorResponse> {
  assertCronAccess(ctx.role, input.target, false);
  if (input.deleteHeartbeat && !can(ctx.role, "heartbeat", "delete")) {
    throw new AppError("FORBIDDEN", "Deleting a heartbeat requires the heartbeat:delete permission", 403);
  }
  await assertServer(serverId);

  const snapshot = await readTarget(serverId, input.target, ctx, input.baseHash);
  const kind = cronKindOf(input.target);
  const lines = parseCrontab(snapshot.content, kind);
  const { entry, index } = findEntry(lines, input.lineNo);

  const unwrapped = unwrapHeartbeatCommand(entry.command);
  if (!unwrapped && entry.heartbeatId === undefined) {
    throw new AppError("VALIDATION_ERROR", "This cron job is not monitored by a heartbeat", 400);
  }
  const linked = await findLinkedHeartbeat(entry, serverId, input.target);
  const hb = linked?.hb ?? null;
  const source = linked?.source ?? null;
  // Prefer what is actually on the line; the stored copy — only ever this target's
  // own heartbeat's — covers a line whose wrapper was hand-edited out of the
  // recognised shape. A marker that names no heartbeat linked here is just stripped.
  const original = unwrapped?.command ?? source?.originalCommand ?? entry.command;

  const keepLabel = !(source?.labelLineInserted && entry.label === source.label);
  const restored: CronEntryLine = { ...entry, command: original };
  delete restored.heartbeatId;
  if (!keepLabel) delete restored.label;
  const updatedLines = lines.slice();
  updatedLines[index] = restored;

  const { hash } = await writeCronTarget(
    serverId,
    { target: input.target, content: serializeCrontab(updatedLines), baseHash: snapshot.hash },
    ctx.audit,
    { overridePassword: ctx.overridePassword, canSudo: can(ctx.role, "server", "sudo") },
  );

  let heartbeatDeleted = false;
  if (hb) {
    if (input.deleteHeartbeat) {
      await prisma.heartbeat.delete({ where: { id: hb.id } });
      heartbeatDeleted = true;
      await writeAuditDirect({
        ctx: ctx.audit,
        category: "data",
        action: "heartbeat.delete",
        entity: "Heartbeat",
        entityId: String(hb.id),
        before: { name: hb.name, schedule: hb.schedule, serverId: hb.serverId, source: "cron_unmonitor" },
      });
    } else {
      // Nothing pings it any more: park it instead of letting it go down.
      await prisma.heartbeat.update({
        where: { id: hb.id },
        data: { status: "paused", expectedAt: null, alertAt: null, cronSource: Prisma.DbNull },
      });
    }
  }

  await writeAuditDirect({
    ctx: ctx.audit,
    category: "data",
    action: "server.cron_unmonitor",
    entity: "Server",
    entityId: String(serverId),
    after: { target: input.target, lineNo: input.lineNo, heartbeatId: hb?.id ?? null, heartbeatDeleted },
  });

  return { hash, heartbeatId: hb?.id ?? null, heartbeatDeleted };
}

/**
 * After a token rotation: point the monitored crontab line at the new token. Reads
 * the target fresh and writes conditionally on that read, so a concurrent edit on
 * the host still fails with CRON_CONFLICT instead of being overwritten.
 */
export async function rewriteCronEntryToken(
  hb: HeartbeatWithServer,
  oldTokenHash: string,
  newToken: string,
  ctx: CronMonitorCtx,
): Promise<{ hash: string }> {
  const source = parseCronSource(hb.cronSource);
  if (!source || hb.serverId === null) {
    throw new AppError("VALIDATION_ERROR", "This heartbeat is not linked to a crontab entry", 400);
  }
  assertCronAccess(ctx.role, source.target, false);
  const pingBase = requirePingBase();

  const snapshot = await readTarget(hb.serverId, source.target, ctx);
  const kind = cronKindOf(source.target);
  const lines = parseCrontab(snapshot.content, kind);
  const index = await findRotationLine(lines, hb.id, oldTokenHash);
  const entry = index >= 0 ? (lines[index] as CronEntryLine) : null;
  const unwrapped = entry ? unwrapHeartbeatCommand(entry.command) : null;
  if (!entry || !unwrapped) {
    throw new AppError("CONFLICT", "The monitored crontab line was not found on the host (was it edited by hand?)", 409);
  }

  let wrapped: string;
  try {
    wrapped = wrapCommandForHeartbeat({ command: unwrapped.command, pingBase, token: newToken, measureDuration: unwrapped.measureDuration });
  } catch (err) {
    wrapError(err);
  }
  const updatedLines = lines.slice();
  updatedLines[index] = { ...entry, command: wrapped, heartbeatId: hb.id };
  const newTokenHash = hashHeartbeatToken(newToken);
  const outcome = await writeCronOrConfirm(
    hb.serverId,
    source.target,
    serializeCrontab(updatedLines),
    snapshot.hash,
    ctx,
    (after) => hasTokenLine(after, newTokenHash),
  );
  if (outcome.ok) return { hash: outcome.hash };
  if (outcome.unconfirmed) {
    throw new CronWriteUnconfirmedError(
      `Could not confirm that the monitored line in ${cronTargetLabel(source.target)} was rewritten (${cronErrorToHttp(outcome.error).message}). ` +
        "The heartbeat keeps the new token in case the host has it: check the line on the host, and if it still carries the old token, rotate again with the crontab rewrite.",
      hb.id,
    );
  }
  throw outcome.error;
}

/**
 * The line a rotation re-points: the one carrying the old token or, failing that,
 * one whose marker names this heartbeat and whose token belongs to no other
 * heartbeat — a copied line keeps its own heartbeat's token and is not taken over.
 */
async function findRotationLine(lines: CronLine[], heartbeatId: number, oldTokenHash: string): Promise<number> {
  const byToken = lines.findIndex((l) => l.type === "entry" && lineTokenHash(l.command) === oldTokenHash);
  if (byToken >= 0) return byToken;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.type !== "entry" || l.heartbeatId !== heartbeatId) continue;
    const tokenHash = lineTokenHash(l.command);
    if (tokenHash === null) continue;
    const owner = await prisma.heartbeat.findUnique({ where: { tokenHash }, select: { id: true } });
    if (!owner || owner.id === heartbeatId) return i;
  }
  return -1;
}

