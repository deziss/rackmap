import type { Prisma } from "@prisma/client";
import {
  ACCESS_GRANT_KEY_MARKER_PREFIX,
  ACCESS_GRANT_MAX_REVOKE_ATTEMPTS,
  accessGrantExpiryError,
  type AccessGrantDto,
  type AccessGrantKind,
  type AccessGrantOnExpiry,
  type AccessGrantStatus,
  type TemporaryUserCreateInput,
  type TemporaryKeyCreateInput,
} from "@inv/shared";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { writeAudit, type AuditCtx } from "../lib/audit.js";
import { can } from "../lib/permissions.js";
import { connectToServer, SshError, VAULT_LOCKED_MESSAGE, type ConnectOptions } from "./ssh.service.js";
import {
  describeRemoteFailure,
  execAsRoot,
  remoteFailureToHttp,
  RemoteFailureError,
  type RemoteScriptResult,
} from "./remote-exec.service.js";
import { escapeShellArg } from "./shell-escape.js";
import {
  createOsUser,
  deleteOsUser,
  grantsPrivilegedAccess,
  osUserErrorToHttp,
  PRIVILEGED_GRANT_MESSAGE,
  PRIVILEGED_OS_GROUPS,
  PrivilegedTargetError,
} from "./os-user.service.js";
import { emitAlert } from "./alerting/emit.js";
import { isSystemVaultUnlocked } from "./vault.service.js";
import { InvalidPublicKeyError, validateTemporaryPublicKey } from "./access-grant-key.js";

/**
 * Time-boxed access grants (temporary OS accounts and SSH keys).
 *
 * Creating a grant changes the host first and records the grant second, with a
 * compensating step if the record cannot be written; revoking claims the row
 * first (`active → expired_pending`, one conditional UPDATE) so the sweeper, a
 * second replica and an operator's "Revoke" button can never revoke the same
 * grant twice or race an extension.
 *
 * Every host script is built here from constants plus values passed through
 * escapeShellArg, and runs as root via execAsRoot. The authorized_keys edits
 * themselves run as the account (runuser), so a user who owns ~/.ssh cannot
 * point RackMap's root shell at another file with a symlink.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AccessGrantActor {
  id: string;
  role: string;
}

export interface AccessGrantCtx {
  actor: AccessGrantActor;
  audit: AuditCtx;
  /** x-ssh-password override for this request. */
  sshPassword?: string;
  /** The caller holds server:sudo: privileged groups, sudo rules and root-equivalent targets are allowed. */
  allowPrivileged: boolean;
}

export interface RevokeOptions {
  /** null = automatic expiry (the sweeper). */
  actor: AccessGrantActor | null;
  audit?: AuditCtx;
  sshPassword?: string;
}

export type RevokeResult =
  | { outcome: "revoked"; grant: AccessGrantRow }
  | { outcome: "failed"; grant: AccessGrantRow; error: unknown }
  /** Another revoke or extend holds the grant, or it is no longer revocable. */
  | { outcome: "skipped"; grant: AccessGrantRow | null };

export const accessGrantInclude = {
  server: { select: { id: true, hostname: true, ip: true, username: true, deletedAt: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  revokedBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.AccessGrantInclude;

export type AccessGrantRow = Prisma.AccessGrantGetPayload<{ include: typeof accessGrantInclude }>;

// ─── Constants ───────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const PATH_LINE = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; export PATH";

/** In-script refusal protocol (exit status + stderr marker), as in os-user.service. */
const PRIVILEGED_EXIT = 77; // EX_NOPERM
const PRIVILEGED_MARKER = "RACKMAP_PRIVILEGED_TARGET";
const NO_USER_EXIT = 67; // EX_NOUSER
const NO_USER_MARKER = "RACKMAP_NO_SUCH_USER";
const LINE_MISSING_EXIT = 3;
const LINE_MISSING_MARKER = "RACKMAP_GRANT_LINE_MISSING";
const WARN_PREFIX = "RACKMAP_WARN:";
const PRIVILEGED_CASE = PRIVILEGED_OS_GROUPS.join("|");

const SCRIPT_TIMEOUT_MS = 120_000;
const USERNAME_PATTERN = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$/;

const WARNING_TEXT: Record<string, string> = {
  "host-expiry-unavailable":
    "The host could not enforce the expiry itself (it needs OpenSSH 8.2+ and date -d); RackMap's own revocation still applies.",
  "authorized-keys-file":
    "sshd on this host reads keys from a non-default AuthorizedKeysFile; the key was written to ~/.ssh/authorized_keys and may not be used.",
  "account-expiry-unavailable":
    "The host-side account expiry (chage/usermod -e) could not be set; RackMap's own revocation still applies.",
};

// ─── Small helpers ───────────────────────────────────────────────────────────

export function grantMarker(grantId: number): string {
  if (!Number.isInteger(grantId) || grantId <= 0) throw new Error(`Invalid grant id ${grantId}`);
  return `${ACCESS_GRANT_KEY_MARKER_PREFIX}${grantId}`;
}

function assertUsername(raw: string): string {
  const u = raw.trim();
  if (!u || u.length > 32 || !USERNAME_PATTERN.test(u)) {
    throw new AppError("VALIDATION_ERROR", "Invalid Linux username format", 400);
  }
  return u;
}

function parseExpiry(value: string | Date, now: Date = new Date()): Date {
  const d = value instanceof Date ? value : new Date(value);
  const err = accessGrantExpiryError(d, now);
  if (err) throw new AppError("VALIDATION_ERROR", err, 400);
  return d;
}

/**
 * The host-side account expiry for `chage -E`, as days since the epoch.
 *
 * shadow disables an account from 00:00 UTC of its expiry day, so the day is the
 * first UTC midnight at or after `expiresAt` (in practice: the UTC date of
 * expiresAt plus one day). The host therefore never locks the account EARLIER
 * than RackMap does, and at most 24 hours later — it is the backstop for when
 * RackMap is down, not the primary clock. A plain day number is used rather
 * than YYYY-MM-DD because chage parses a date in the host's local time zone,
 * which is off by a day on UTC+13/+14 hosts; `chage -l` still shows it as a date.
 */
export function hostAccountExpiryDay(expiresAt: Date): number {
  return Math.ceil(expiresAt.getTime() / DAY_MS);
}

/** The same day as YYYY-MM-DD, for messages and audit. */
export function hostAccountExpiryDate(expiresAt: Date): string {
  return new Date(hostAccountExpiryDay(expiresAt) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Epoch seconds for the key's `expiry-time=` option: expiresAt rounded UP to
 * the minute, because the option has minute resolution and must not cut the
 * key off before RackMap does. The host turns it into its own local
 * YYYYMMDDHHMM (sshd reads the option in the system time zone).
 */
export function keyExpiryEpoch(expiresAt: Date): number {
  return Math.ceil(expiresAt.getTime() / 60_000) * 60;
}

function errMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function truncate(s: string, max = 1000): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** lastError text, prefixed with a code an operator (or the UI) can branch on. */
export function describeGrantFailure(err: unknown): string {
  const vaultHint = isSystemVaultUnlocked()
    ? ""
    : " Background revocation needs the vault unlocked for the whole deployment (global unlock or VAULT_PASSPHRASE).";
  if (err instanceof SshError) {
    if (err.kind === "vault_locked") return truncate(`VAULT_LOCKED: ${VAULT_LOCKED_MESSAGE}${vaultHint}`);
    return truncate(`${err.kind.toUpperCase()}: ${err.message}`);
  }
  if (err instanceof RemoteFailureError) {
    return truncate(`${err.code}: ${err.message}${err.code === "VAULT_LOCKED" ? vaultHint : ""}`);
  }
  if (err instanceof PrivilegedTargetError) return truncate(`FORBIDDEN: ${err.message}`);
  return truncate(errMessage(err));
}

/** HTTP mapping for errors thrown by this service (AppError keeps its own). */
export function accessGrantErrorToHttp(
  err: unknown,
  fallbackCode: string,
): { status: 400 | 403 | 404 | 409 | 500 | 503 | 504; code: string; message: string } {
  if (err instanceof AppError) {
    const status = ([400, 403, 404, 409, 500] as const).find((s) => s === err.status) ?? 400;
    return { status, code: err.code, message: err.message };
  }
  if (err instanceof InvalidPublicKeyError) return { status: 400, code: "VALIDATION_ERROR", message: err.message };
  return osUserErrorToHttp(err, fallbackCode);
}

/** A script that ran and failed; carries the result so callers can tell "not written" from "unknown". */
class GrantScriptError extends Error {
  readonly result: RemoteScriptResult;
  constructor(message: string, result: RemoteScriptResult) {
    super(message);
    this.name = "GrantScriptError";
    this.result = result;
  }
}

/** True when a failed run may nevertheless have changed the host (timeout, lost channel). */
function outcomeUnknown(err: unknown): boolean {
  if (err instanceof RemoteFailureError) return err.code === "TIMEOUT";
  if (err instanceof GrantScriptError) return err.result.exitCode === null || err.result.cancelled || err.result.timedOut;
  return false;
}

function warningsFrom(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith(WARN_PREFIX)) continue;
    const text = WARNING_TEXT[t.slice(WARN_PREFIX.length)];
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

// ─── Host scripts ────────────────────────────────────────────────────────────

/** Refuse (exit 77 + marker) when $u is root-equivalent: uid 0, a privileged group, or any sudoers rule. */
function privilegedGuardLines(): string[] {
  const refuse = `{ echo ${PRIVILEGED_MARKER} >&2; exit ${PRIVILEGED_EXIT}; }`;
  return [
    `[ "$(id -u "$u")" = 0 ] && ${refuse}`,
    `for g in $(id -Gn "$u" 2>/dev/null); do case "$g" in ${PRIVILEGED_CASE}) ${refuse};; esac; done`,
    `if command -v sudo >/dev/null 2>&1 && LC_ALL=C sudo -n -l -U "$u" 2>/dev/null | grep -q 'may run the following'; then ${refuse}; fi`,
  ];
}

const REQUIRE_USER = `id "$u" >/dev/null 2>&1 || { echo ${NO_USER_MARKER} >&2; exit ${NO_USER_EXIT}; }`;

/**
 * chage -E <day> (usermod -e where chage is missing). A host with neither tool
 * never had a host-side expiry, so that only prints a warning; a tool that is
 * there and fails exits non-zero — an extension must not be recorded while the
 * host keeps the old day (createTemporaryUser turns the error into a warning).
 */
export function buildAccountExpiryScript(username: string, expiresAt: Date, opts: { guard: boolean }): string {
  const day = escapeShellArg(String(hostAccountExpiryDay(expiresAt)));
  return [
    PATH_LINE,
    `u=${escapeShellArg(username)}`,
    REQUIRE_USER,
    ...(opts.guard ? privilegedGuardLines() : []),
    `if command -v chage >/dev/null 2>&1; then chage -E ${day} "$u" || exit $?`,
    `elif command -v usermod >/dev/null 2>&1; then usermod -e ${day} "$u" || exit $?`,
    `else echo ${WARN_PREFIX}account-expiry-unavailable; fi`,
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Lock a temporary account: password locked, account expired (day 1 — passwd(1)'s
 * `usermod --expiredate 1`; day 0 is "no expiry" to parts of shadow), RackMap's
 * sudoers rule removed, every process of the account killed. An account that no
 * longer exists counts as revoked. uid 0 is refused outright: `pkill -u` would
 * take the host down.
 */
export function buildLockAccountScript(username: string): string {
  const sudoers = escapeShellArg(`/etc/sudoers.d/rackmap_${username}`);
  return [
    PATH_LINE,
    `u=${escapeShellArg(username)}`,
    `if ! id "$u" >/dev/null 2>&1; then echo ${NO_USER_MARKER}; exit 0; fi`,
    `[ "$(id -u "$u")" = 0 ] && { echo "RackMap: refusing to lock a uid-0 account" >&2; exit 1; }`,
    `usermod -L "$u" || exit $?`,
    `if command -v chage >/dev/null 2>&1; then chage -E 1 "$u"; else usermod -e 1 "$u"; fi || exit $?`,
    `rm -f ${sudoers} || exit $?`,
    `pkill -KILL -u "$u" 2>/dev/null || true`,
    "exit 0",
    "",
  ].join("\n");
}

/**
 * deleteOsUser's steps (userdel -r -f, drop RackMap's sudoers rule) for a server
 * that has been removed from the inventory, which deleteOsUser does not reach.
 * An account that no longer exists counts as deleted; uid 0 is refused.
 */
export function buildDeleteAccountScript(username: string): string {
  const sudoers = escapeShellArg(`/etc/sudoers.d/rackmap_${username}`);
  return [
    PATH_LINE,
    `u=${escapeShellArg(username)}`,
    `if ! id "$u" >/dev/null 2>&1; then echo ${NO_USER_MARKER}; exit 0; fi`,
    `[ "$(id -u "$u")" = 0 ] && { echo "RackMap: refusing to delete a uid-0 account" >&2; exit 1; }`,
    `userdel -r -f "$u" || exit $?`,
    `rm -f ${sudoers} || exit $?`,
    "exit 0",
    "",
  ].join("\n");
}

/**
 * The authorized_keys editor, run AS THE ACCOUNT (runuser) so the kernel — not a
 * chain of `[ -L ]` checks — keeps every read and write inside what the account
 * itself may touch. Constant text; all values arrive as positional parameters:
 *   $1 action  add | remove | update
 *   $2 home    the account's home directory (from getent, resolved as root)
 *   $3 marker  rackmap-grant:<id>
 *   $4 ts      expiry-time value (host-local YYYYMMDDHHMM) or empty
 *   $5 key     "<type> <base64> [comment] rackmap-grant:<id>" (add only)
 * A line belongs to the grant when its LAST field equals the marker exactly, so
 * rackmap-grant:1 never matches rackmap-grant:12. The file is replaced by an
 * atomic rename of a mktemp file in the same directory, keeping its mode.
 */
export const AUTHORIZED_KEYS_EDITOR = [
  "umask 077",
  'action=$1 home=$2 marker=$3 ts=$4 key=$5',
  'cd -- "$home" 2>/dev/null || { echo "RackMap: cannot enter the home directory $home" >&2; exit 1; }',
  "if [ ! -d .ssh ]; then",
  `  [ "$action" = remove ] && { echo RACKMAP_GRANT_REMOVED=0; exit 0; }`,
  `  [ "$action" = update ] && { echo ${LINE_MISSING_MARKER} >&2; exit ${LINE_MISSING_EXIT}; }`,
  "  mkdir .ssh || exit 1",
  "fi",
  "cd .ssh || exit 1",
  "f=authorized_keys",
  'if [ -e "$f" ] && [ ! -O "$f" ]; then echo "RackMap: $home/.ssh/$f is not owned by the account; refusing to replace it" >&2; exit 1; fi',
  "n=0",
  'if [ -f "$f" ]; then',
  `  n=$(M="$marker" awk '$NF == ENVIRON["M"] { n++ } END { print n + 0 }' "$f") || exit 1`,
  "else",
  `  [ "$action" = remove ] && { echo RACKMAP_GRANT_REMOVED=0; exit 0; }`,
  `  [ "$action" = update ] && { echo ${LINE_MISSING_MARKER} >&2; exit ${LINE_MISSING_EXIT}; }`,
  "fi",
  `[ "$action" = remove ] && [ "$n" = 0 ] && { echo RACKMAP_GRANT_REMOVED=0; exit 0; }`,
  `[ "$action" = update ] && [ "$n" = 0 ] && { echo ${LINE_MISSING_MARKER} >&2; exit ${LINE_MISSING_EXIT}; }`,
  "tmp=$(mktemp .rackmap_ak.XXXXXXXX) || exit 1",
  'if [ -f "$f" ]; then',
  '  mode=$(stat -c %a -- "$f" 2>/dev/null) && chmod "$mode" "$tmp" 2>/dev/null',
  "  M=\"$marker\" TS=\"$ts\" A=\"$action\" awk '",
  '    $NF == ENVIRON["M"] {',
  '      if (ENVIRON["A"] != "update") next',
  '      if (ENVIRON["TS"] != "") { if (!sub(/^expiry-time="[0-9]*"/, "expiry-time=\\"" ENVIRON["TS"] "\\"")) $0 = "expiry-time=\\"" ENVIRON["TS"] "\\" " $0 }',
  '      else sub(/^expiry-time="[0-9]*" /, "")',
  "    }",
  "    { print }",
  `  ' "$f" > "$tmp" || { rm -f "$tmp"; exit 1; }`,
  "fi",
  'if [ "$action" = add ]; then',
  '  if [ -n "$ts" ]; then printf \'expiry-time="%s" %s\\n\' "$ts" "$key" >> "$tmp"; else printf \'%s\\n\' "$key" >> "$tmp"; fi || { rm -f "$tmp"; exit 1; }',
  "fi",
  'mv -f -- "$tmp" "$f" || { rm -f "$tmp"; exit 1; }',
  'echo "RACKMAP_GRANT_OK=$n"',
  "exit 0",
].join("\n");

export interface KeyScriptInput {
  action: "add" | "remove" | "update";
  username: string;
  grantId: number;
  /** add: the normalised public key line (without marker). */
  keyLine?: string;
  /** add / update: the grant's expiry. */
  expiresAt?: Date;
  /** Refuse root-equivalent accounts (the caller lacks server:sudo). */
  guard: boolean;
}

/** Root wrapper: resolve the account, run the guards, compute expiry-time, hand over to the editor. */
export function buildKeyScript(input: KeyScriptInput): string {
  const marker = grantMarker(input.grantId);
  const keyArg = input.action === "add" ? `${input.keyLine ?? ""} ${marker}` : "";
  if (input.action === "add" && !input.keyLine) throw new Error("A key line is required to add a key");
  if (/[\r\n\0]/.test(keyArg)) throw new Error("The key line must be a single line");

  const lines = [PATH_LINE, `u=${escapeShellArg(input.username)}`];
  if (input.action === "remove") {
    // Nothing to remove from an account that no longer exists.
    lines.push(`if ! id "$u" >/dev/null 2>&1; then echo RACKMAP_GRANT_REMOVED=0; echo ${NO_USER_MARKER}; exit 0; fi`);
  } else {
    lines.push(REQUIRE_USER);
    if (input.guard) lines.push(...privilegedGuardLines());
  }
  lines.push(
    `home=$(getent passwd "$u" | cut -d: -f6)`,
    `case "$home" in /*) ;; *) echo "RackMap: $u has no absolute home directory" >&2; exit 1;; esac`,
    "ts=",
  );
  if (input.action !== "remove" && input.expiresAt) {
    const epoch = escapeShellArg(String(keyExpiryEpoch(input.expiresAt)));
    lines.push(
      // expiry-time= is enforced from OpenSSH 8.2; an older sshd would reject
      // the whole line as a bad option, so it is only written where it works.
      `v=$(ssh -V 2>&1 | sed -n 's/^OpenSSH_\\([0-9][0-9]*\\)\\.\\([0-9][0-9]*\\).*/\\1 \\2/p' | head -n 1)`,
      `maj=\${v% *} min=\${v#* }`,
      `if [ -n "$v" ] && { [ "$maj" -gt 8 ] || { [ "$maj" -eq 8 ] && [ "$min" -ge 2 ]; }; }; then`,
      `  ts=$(unset TZ; date -d @${epoch} +%Y%m%d%H%M 2>/dev/null)`,
      `  case "$ts" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) ts= ;; esac`,
      "fi",
      `[ -n "$ts" ] || echo ${WARN_PREFIX}host-expiry-unavailable`,
    );
  }
  if (input.action === "add") {
    lines.push(
      `akf=$(sshd -T 2>/dev/null | awk 'tolower($1) == "authorizedkeysfile" { $1 = ""; print }')`,
      `case "$akf" in ''|*.ssh/authorized_keys*) ;; *) echo ${WARN_PREFIX}authorized-keys-file ;; esac`,
    );
  }
  lines.push(
    `editor=${escapeShellArg(AUTHORIZED_KEYS_EDITOR)}`,
    `if [ "$(id -u "$u")" = 0 ]; then`,
    `  set -- sh -c "$editor" sh`,
    "else",
    `  command -v runuser >/dev/null 2>&1 || { echo 'RackMap: runuser (util-linux) is required to edit authorized_keys' >&2; exit 127; }`,
    `  set -- runuser -u "$u" -- sh -c "$editor" sh`,
    "fi",
    `"$@" ${escapeShellArg(input.action)} "$home" ${escapeShellArg(marker)} "$ts" ${escapeShellArg(keyArg)}`,
    "",
  );
  return lines.join("\n");
}

/**
 * Run a grant script as root; throws the same error classes as os-user.service's writes.
 * `allowDeleted` is for the revoke path only: access must still be taken away
 * from a server that was removed from the inventory meanwhile.
 */
async function runGrantScript(
  serverId: number,
  script: string,
  sshPassword: string | undefined,
  failurePrefix: string,
  opts: { allowDeleted?: boolean } = {},
): Promise<RemoteScriptResult> {
  // The options form of connectToServer(serverId, sshPassword) — same auth rules — plus allowDeleted.
  const connect: string | ConnectOptions | undefined = opts.allowDeleted
    ? { ...(typeof sshPassword === "string" ? { overridePassword: sshPassword, preferredAuth: "password" as const } : {}), allowDeleted: true }
    : sshPassword;
  const { client, password, passwordUnavailable } = await connectToServer(serverId, connect);
  let result: RemoteScriptResult;
  try {
    result = await execAsRoot(client, script, password, { timeoutMs: SCRIPT_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
  } finally {
    client.end();
  }
  const failure = remoteFailureToHttp(result, { passwordUnavailable });
  if (failure) throw new RemoteFailureError(failure, `${failurePrefix}: ${failure.message}`);
  if (result.exitCode === PRIVILEGED_EXIT && result.stderr.includes(PRIVILEGED_MARKER)) {
    throw new PrivilegedTargetError(
      "The target account is root-equivalent on this host; granting access to it requires the server:sudo permission",
    );
  }
  if (result.exitCode === NO_USER_EXIT && result.stderr.includes(NO_USER_MARKER)) {
    throw new AppError("VALIDATION_ERROR", `${failurePrefix}: the account does not exist on this server`, 400);
  }
  if (result.exitCode === LINE_MISSING_EXIT && result.stderr.includes(LINE_MISSING_MARKER)) {
    throw new AppError("CONFLICT", `${failurePrefix}: the key is no longer in the account's authorized_keys`, 409);
  }
  if (result.exitCode !== 0 || result.errorCode) {
    throw new GrantScriptError(`${failurePrefix}: ${describeRemoteFailure(result)}`, result);
  }
  return result;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

async function assertServer(serverId: number): Promise<{ id: number; hostname: string; username: string }> {
  const server = await prisma.server.findFirst({
    where: { id: serverId, deletedAt: null },
    select: { id: true, hostname: true, username: true },
  });
  if (!server) throw new AppError("NOT_FOUND", "Server not found", 404);
  return server;
}

export async function loadGrant(id: number): Promise<AccessGrantRow> {
  const grant = await prisma.accessGrant.findUnique({ where: { id }, include: accessGrantInclude });
  if (!grant) throw new AppError("NOT_FOUND", "Access grant not found", 404);
  return grant;
}

export async function listGrants(filter: { serverId?: number; status?: AccessGrantStatus; kind?: AccessGrantKind }) {
  return prisma.accessGrant.findMany({
    where: {
      ...(filter.serverId ? { serverId: filter.serverId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
    },
    include: accessGrantInclude,
    orderBy: [{ createdAt: "desc" }],
    take: 500,
  });
}

/** Whether `actor` may extend / revoke `grant`: the creator, or anyone holding accessGrant:revoke. */
export function grantPermissions(grant: Pick<AccessGrantRow, "createdById" | "status" | "expiresAt">, actor: AccessGrantActor, now = new Date()) {
  const isCreator = !!grant.createdById && grant.createdById === actor.id;
  const manager = can(actor.role, "accessGrant", "revoke");
  const creator = isCreator && can(actor.role, "accessGrant", "create");
  return {
    canExtend:
      grant.status === "active" && grant.expiresAt > now && can(actor.role, "accessGrant", "create") && (isCreator || manager),
    canRevoke: (grant.status === "active" || grant.status === "failed") && (manager || creator),
  };
}

export function toAccessGrantDto(g: AccessGrantRow, actor: AccessGrantActor, now = new Date()): AccessGrantDto {
  const perms = grantPermissions(g, actor, now);
  return {
    id: g.id,
    serverId: g.serverId,
    server: g.server ? { id: g.server.id, hostname: g.server.hostname, ip: g.server.ip } : null,
    kind: g.kind as AccessGrantKind,
    username: g.username,
    keyFingerprint: g.keyFingerprint,
    onExpiry: g.onExpiry as AccessGrantOnExpiry,
    reason: g.reason,
    expiresAt: g.expiresAt.toISOString(),
    status: g.status as AccessGrantStatus,
    attempts: g.attempts,
    lastError: g.lastError,
    revokedAt: g.revokedAt ? g.revokedAt.toISOString() : null,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    createdBy: g.createdBy ? { id: g.createdBy.id, name: g.createdBy.name, email: g.createdBy.email } : null,
    revokedBy: g.revokedBy ? { id: g.revokedBy.id, name: g.revokedBy.name, email: g.revokedBy.email } : null,
    ...perms,
  };
}

function auditView(g: { serverId: number; kind: string; username: string; keyFingerprint: string | null; onExpiry: string; expiresAt: Date; reason: string | null }) {
  return {
    serverId: g.serverId,
    kind: g.kind,
    username: g.username,
    keyFingerprint: g.keyFingerprint,
    onExpiry: g.onExpiry,
    expiresAt: g.expiresAt.toISOString(),
    reason: g.reason,
  };
}

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Create a temporary account: createOsUser (same privileged rules as the
 * OS-users tab), then the host-side expiry, then the grant row. Should the row
 * fail to insert, the account just created is locked again so no untracked
 * account outlives the request.
 */
export async function createTemporaryUser(
  input: TemporaryUserCreateInput,
  ctx: AccessGrantCtx,
): Promise<{ grant: AccessGrantRow; warnings: string[] }> {
  const username = assertUsername(input.username);
  const expiresAt = parseExpiry(input.expiresAt);
  if (!ctx.allowPrivileged && grantsPrivilegedAccess(input)) {
    throw new AppError("FORBIDDEN", PRIVILEGED_GRANT_MESSAGE, 403);
  }
  const server = await assertServer(input.serverId);
  if (username.toLowerCase() === "root" || username === server.username) {
    throw new AppError("VALIDATION_ERROR", `"${username}" already exists on this server; a temporary account needs a new name`, 400);
  }

  await createOsUser(
    server.id,
    {
      username,
      password: input.password,
      shell: input.shell || undefined,
      groups: input.groups,
      sudoType: input.sudoType,
      customCommands: input.customCommands,
      createHome: true,
    },
    ctx.audit,
    ctx.sshPassword,
    { allowPrivileged: ctx.allowPrivileged },
  );

  const warnings: string[] = [];
  try {
    const r = await runGrantScript(
      server.id,
      buildAccountExpiryScript(username, expiresAt, { guard: false }),
      ctx.sshPassword,
      `Failed to set the account expiry for ${username}`,
    );
    warnings.push(...warningsFrom(r.stdout));
  } catch (err) {
    warnings.push(`${WARNING_TEXT["account-expiry-unavailable"]} (${describeGrantFailure(err)})`);
  }

  let grant: AccessGrantRow;
  try {
    grant = await prisma.accessGrant.create({
      data: {
        serverId: server.id,
        kind: "os_user",
        username,
        onExpiry: input.onExpiry,
        reason: input.reason,
        expiresAt,
        status: "active",
        createdById: ctx.actor.id,
      },
      include: accessGrantInclude,
    });
  } catch (err) {
    let locked = true;
    try {
      await runGrantScript(server.id, buildLockAccountScript(username), ctx.sshPassword, `Failed to lock ${username}`);
    } catch {
      locked = false;
    }
    console.error("[access-grants] grant row insert failed after creating the account:", errMessage(err));
    throw new AppError(
      "INTERNAL",
      locked
        ? `The account ${username} was created but the grant could not be recorded, so RackMap locked the account again.`
        : `The account ${username} was created but the grant could not be recorded, and locking it failed too — lock or delete it on the host by hand.`,
      500,
    );
  }

  await writeAudit({
    ctx: ctx.audit,
    category: "security",
    action: "access_grant.create",
    entity: "access_grant",
    entityId: String(grant.id),
    after: { ...auditView(grant), hostExpiryDate: hostAccountExpiryDate(expiresAt), groups: input.groups, sudoType: input.sudoType ?? "none" },
  });
  return { grant, warnings };
}

/**
 * Add a temporary key to an existing account. The row is written first because
 * the key line carries its id (`rackmap-grant:<id>`); if the host step fails the
 * row is removed again — unless the outcome is unknown (timeout), in which case
 * the grant is expired immediately so the sweeper removes any line that did land.
 */
export async function grantTemporaryKey(
  input: TemporaryKeyCreateInput,
  ctx: AccessGrantCtx,
): Promise<{ grant: AccessGrantRow; warnings: string[] }> {
  const username = assertUsername(input.username);
  const expiresAt = parseExpiry(input.expiresAt);
  if (username === "root" && !ctx.allowPrivileged) {
    throw new AppError("FORBIDDEN", "Granting a key for root requires the server:sudo permission", 403);
  }
  let key;
  try {
    key = validateTemporaryPublicKey(input.publicKey);
  } catch (err) {
    throw new AppError("VALIDATION_ERROR", errMessage(err), 400);
  }
  const server = await assertServer(input.serverId);

  const row = await prisma.accessGrant.create({
    data: {
      serverId: server.id,
      kind: "ssh_key",
      username,
      keyFingerprint: key.fingerprint,
      onExpiry: "remove",
      reason: input.reason,
      expiresAt,
      status: "active",
      createdById: ctx.actor.id,
    },
  });

  let result: RemoteScriptResult;
  try {
    result = await runGrantScript(
      server.id,
      buildKeyScript({ action: "add", username, grantId: row.id, keyLine: key.line, expiresAt, guard: !ctx.allowPrivileged }),
      ctx.sshPassword,
      `Failed to add the key for ${username}`,
    );
  } catch (err) {
    try {
      if (outcomeUnknown(err)) {
        await prisma.accessGrant.update({
          where: { id: row.id },
          data: { expiresAt: new Date(), lastError: truncate(`Grant not confirmed: ${describeGrantFailure(err)}`) },
        });
      } else {
        await prisma.accessGrant.delete({ where: { id: row.id } });
      }
    } catch (cleanupErr) {
      console.error(`[access-grants] cleanup of grant ${row.id} failed:`, errMessage(cleanupErr));
    }
    throw err;
  }

  const grant = await loadGrant(row.id);
  await writeAudit({
    ctx: ctx.audit,
    category: "security",
    action: "access_grant.create",
    entity: "access_grant",
    entityId: String(grant.id),
    after: { ...auditView(grant), keyType: key.type, keyComment: key.comment },
  });
  return { grant, warnings: warningsFrom(result.stdout) };
}

// ─── Extend ──────────────────────────────────────────────────────────────────

/**
 * Move an active, not yet expired grant's expiry (later or earlier) and update
 * the host's own expiry to match. The row is held in `expired_pending` while the
 * host is changed, so the sweeper cannot revoke it halfway through.
 */
export async function extendGrant(
  grantId: number,
  newExpiresAt: string | Date,
  ctx: AccessGrantCtx,
): Promise<{ grant: AccessGrantRow; warnings: string[] }> {
  const now = new Date();
  const expiresAt = parseExpiry(newExpiresAt, now);
  const before = await loadGrant(grantId);
  if (!grantPermissions(before, ctx.actor, now).canExtend) {
    if (before.status !== "active" || before.expiresAt <= now) {
      throw new AppError("CONFLICT", "Only an active grant that has not expired yet can be extended", 409);
    }
    throw new AppError("FORBIDDEN", "Only the grant's creator or an administrator can extend it", 403);
  }

  const claim = await prisma.accessGrant.updateMany({
    where: { id: grantId, status: "active", expiresAt: { gt: now } },
    data: { status: "expired_pending" },
  });
  if (claim.count === 0) throw new AppError("CONFLICT", "The grant is being revoked or changed; try again", 409);

  let warnings: string[] = [];
  try {
    const script =
      before.kind === "ssh_key"
        ? buildKeyScript({ action: "update", username: before.username, grantId, expiresAt, guard: !ctx.allowPrivileged })
        : buildAccountExpiryScript(before.username, expiresAt, { guard: !ctx.allowPrivileged });
    const r = await runGrantScript(before.serverId, script, ctx.sshPassword, `Failed to extend access for ${before.username}`);
    warnings = warningsFrom(r.stdout);
  } catch (err) {
    await prisma.accessGrant.update({ where: { id: grantId }, data: { status: "active" } });
    throw err;
  }

  const grant = await prisma.accessGrant.update({
    where: { id: grantId },
    data: { status: "active", expiresAt, attempts: 0, lastError: null },
    include: accessGrantInclude,
  });
  await writeAudit({
    ctx: ctx.audit,
    category: "security",
    action: "access_grant.extend",
    entity: "access_grant",
    entityId: String(grantId),
    before: { expiresAt: before.expiresAt.toISOString() },
    after: { expiresAt: expiresAt.toISOString(), username: before.username, kind: before.kind, serverId: before.serverId },
  });
  return { grant, warnings };
}

// ─── Revoke ──────────────────────────────────────────────────────────────────

/**
 * Remove the access from the host. Throws on failure. Works on a soft-deleted
 * server too: removing it from the inventory does not take the access away.
 */
async function revokeOnHost(grant: AccessGrantRow, sshPassword: string | undefined, audit: AuditCtx): Promise<void> {
  const reach = { allowDeleted: true };
  if (grant.kind === "ssh_key") {
    await runGrantScript(
      grant.serverId,
      buildKeyScript({ action: "remove", username: grant.username, grantId: grant.id, guard: false }),
      sshPassword,
      `Failed to remove the temporary key for ${grant.username}`,
      reach,
    );
    return;
  }

  if (grant.server && grant.server.username === grant.username) {
    throw new Error(`Refusing to lock ${grant.username}: it is the account RackMap itself uses to reach this server`);
  }
  // Lock first in both modes: it ends the account's sessions and processes,
  // which userdel does not, and it is what stays in force if the delete fails.
  const r = await runGrantScript(
    grant.serverId,
    buildLockAccountScript(grant.username),
    sshPassword,
    `Failed to lock ${grant.username}`,
    reach,
  );
  if (grant.onExpiry !== "delete" || r.stdout.includes(NO_USER_MARKER)) return;
  if (grant.server?.deletedAt) {
    // deleteOsUser only reaches servers that are still in the inventory.
    await runGrantScript(
      grant.serverId,
      buildDeleteAccountScript(grant.username),
      sshPassword,
      `Failed to delete user ${grant.username}`,
      reach,
    );
    return;
  }
  // RackMap created this account for the grant, so removing it is never a
  // privilege grant — even if it was given sudo (by an admin) at creation.
  await deleteOsUser(grant.serverId, grant.username, { removeHome: true, force: true }, audit, sshPassword, {
    allowPrivileged: true,
  });
}

async function safeEmit(e: Parameters<typeof emitAlert>[0]): Promise<void> {
  try {
    await emitAlert(e);
  } catch (err) {
    console.error("[access-grants] alert emit failed:", errMessage(err));
  }
}

function describeAccess(g: AccessGrantRow): string {
  const host = g.server?.hostname ?? `server ${g.serverId}`;
  if (g.kind !== "ssh_key") return `account ${g.username}@${host}`;
  return g.keyFingerprint ? `key ${g.keyFingerprint} for ${g.username}@${host}` : `key for ${g.username}@${host}`;
}

/**
 * Revoke a grant. `actor: null` is the sweeper (automatic expiry): it may only
 * take `active` grants; a person may also retry a `failed` one. The claim is a
 * single conditional UPDATE, so of any number of concurrent callers exactly one
 * touches the host.
 */
export async function revokeGrant(grantId: number, opts: RevokeOptions): Promise<RevokeResult> {
  const automatic = opts.actor === null;
  const claimable: AccessGrantStatus[] = automatic ? ["active"] : ["active", "failed"];
  const prior = await prisma.accessGrant.findUnique({ where: { id: grantId }, select: { status: true, attempts: true } });
  if (!prior || !claimable.includes(prior.status as AccessGrantStatus)) {
    return { outcome: "skipped", grant: prior ? await loadGrant(grantId) : null };
  }
  const claim = await prisma.accessGrant.updateMany({
    where: { id: grantId, status: prior.status },
    data: { status: "expired_pending" },
  });
  if (claim.count === 0) return { outcome: "skipped", grant: await loadGrant(grantId).catch(() => null) };

  const grant = await loadGrant(grantId);
  const audit: AuditCtx = opts.audit ?? {};
  const alertedBefore = prior.status === "failed" || prior.attempts >= ACCESS_GRANT_MAX_REVOKE_ATTEMPTS;

  try {
    await revokeOnHost(grant, opts.sshPassword, audit);
  } catch (err) {
    const attempts = grant.attempts + 1;
    const exhausted = attempts >= ACCESS_GRANT_MAX_REVOKE_ATTEMPTS;
    const lastError = describeGrantFailure(err);
    const updated = await prisma.accessGrant.update({
      where: { id: grantId },
      data: { attempts, lastError, status: exhausted ? "failed" : "active" },
      include: accessGrantInclude,
    });
    if (exhausted && !alertedBefore) {
      await safeEmit({
        type: "access_revoke_failed",
        severity: "critical",
        action: "trigger",
        dedupKey: `rackmap:access:${grantId}`,
        title: `Could not revoke temporary ${describeAccess(grant)}`,
        summary: `RackMap failed ${attempts} times to revoke this grant, which ${
          grant.expiresAt <= new Date() ? "has expired" : "was revoked manually"
        }. The access may still work. Last error: ${lastError}`,
        serverId: grant.serverId,
        payload: { grantId, kind: grant.kind, username: grant.username, attempts, lastError, expiresAt: grant.expiresAt },
      });
    }
    return { outcome: "failed", grant: updated, error: err };
  }

  const now = new Date();
  const revoked = await prisma.accessGrant.update({
    where: { id: grantId },
    data: { status: "revoked", revokedAt: now, revokedById: opts.actor?.id ?? null, lastError: null },
    include: accessGrantInclude,
  });
  await writeAudit({
    ctx: audit,
    category: "security",
    action: "access_grant.revoke",
    entity: "access_grant",
    entityId: String(grantId),
    after: { ...auditView(grant), automatic, onExpiry: grant.onExpiry, attempts: grant.attempts + 1 },
  });

  const verb = grant.kind === "ssh_key" ? "removed" : grant.onExpiry === "delete" ? "deleted" : "locked";
  if (alertedBefore) {
    // Close the incident the failure opened, whoever finally revoked it.
    await safeEmit({
      type: "access_expired",
      severity: "info",
      action: "resolve",
      dedupKey: `rackmap:access:${grantId}`,
      title: `Temporary ${describeAccess(grant)} revoked`,
      summary: `RackMap ${verb} the temporary access after ${grant.attempts + 1} attempts.`,
      serverId: grant.serverId,
      payload: { grantId, kind: grant.kind, username: grant.username, automatic },
    });
  } else if (automatic) {
    await safeEmit({
      type: "access_expired",
      severity: "info",
      action: "info",
      title: `Temporary ${describeAccess(grant)} expired`,
      summary: `The grant expired at ${grant.expiresAt.toISOString()} and RackMap ${verb} the access.${
        grant.reason ? ` Reason given: ${grant.reason}` : ""
      }`,
      serverId: grant.serverId,
      payload: { grantId, kind: grant.kind, username: grant.username, onExpiry: grant.onExpiry, expiresAt: grant.expiresAt },
    });
  }
  return { outcome: "revoked", grant: revoked };
}
