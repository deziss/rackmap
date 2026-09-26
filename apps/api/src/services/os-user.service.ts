import { prisma } from "../db.js";
import { connectToServer, SshError, sshErrorToHttp } from "./ssh.service.js";
import { escapeShellArg } from "./shell-escape.js";
import {
  execAsRoot,
  execPreferRoot,
  describeRemoteFailure,
  remoteFailureToHttp,
  RemoteFailureError,
  type RemoteScriptResult,
} from "./remote-exec.service.js";
import { writeAudit, type AuditCtx } from "../lib/audit.js";
import type { OsUserInfo, SudoPermissionInput, CreateOsUserInput, UpdateOsUserInput, DeleteOsUserInput } from "@inv/shared";

function sanitizeUsername(username: string): string {
  const sanitized = username.trim();
  if (!/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$/.test(sanitized)) {
    throw new Error("Invalid Linux username format");
  }
  return sanitized;
}

/**
 * The patterns below mirror packages/shared/src/schemas/os-user.ts. Everything
 * built in this module ends up on a root shell on the managed host, so the
 * format is re-checked here and never trusted to have been validated upstream.
 */
const ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9._@+-]+)*$/;
const GROUP_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/;
const SUDO_COMMAND_PATTERN = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*(?: [A-Za-z0-9._@+/-]+)*$/;
// Case-sensitive on purpose: sudoers keywords and tags are uppercase, so this
// rejects `ALL` / `NOPASSWD` without also rejecting `/usr/bin/passwd`.
const SUDO_RESERVED_WORD_PATTERN =
  /\b(?:ALL|NOPASSWD|PASSWD|SETENV|NOSETENV|EXEC|NOEXEC|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT|MAIL|NOMAIL|FOLLOW|NOFOLLOW)\b/;

/**
 * Groups whose members are root-equivalent (sudo/wheel/admin grant sudo; docker,
 * lxd and disk give root through the daemon or the raw block device; adm and
 * shadow expose logs and password hashes). Granting any of them — or any sudo
 * rule — needs `server:sudo`, not just `server:osUsers`.
 */
export const PRIVILEGED_OS_GROUPS = ["sudo", "wheel", "admin", "docker", "lxd", "disk", "root", "adm", "shadow"] as const;
const PRIVILEGED_GROUP_SET = new Set<string>(PRIVILEGED_OS_GROUPS);

/** True when a create/update request would grant root-equivalent access. */
export function grantsPrivilegedAccess(input: { sudoType?: string; groups?: string[] }): boolean {
  if (input.sudoType !== undefined && input.sudoType !== "none") return true;
  // Case-folded on purpose: over-matching "Docker" costs an admin a click,
  // under-matching would be an escalation.
  return (input.groups ?? []).some((g) => PRIVILEGED_GROUP_SET.has(g.trim().toLowerCase()));
}

/**
 * Raised when the target account (or a requested primary group) turns out to be
 * root-equivalent on the host and the caller lacks `server:sudo`. Setting the
 * password of a sudo-group user is as good as a sudo grant, so the route-level
 * check on the request body is not enough on its own.
 */
export class PrivilegedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivilegedTargetError";
  }
}

/** 403 message for a create/update body that grants sudo or a privileged group without `server:sudo`. */
export const PRIVILEGED_GRANT_MESSAGE =
  "Granting sudo rights or a privileged group (sudo, wheel, admin, docker, lxd, disk, root, adm, shadow) requires the server:sudo permission";

/**
 * Map an error from the OS-user service to an HTTP response. Privileged-target
 * refusals are 403, SSH errors keep their sshErrorToHttp mapping, failures
 * around the root script keep remoteFailureToHttp's (unreachable 503, a locked
 * vault 409 VAULT_LOCKED, sudo 409, timeout 504), and everything else — including
 * a failed useradd — stays the 400 the routes have always returned.
 */
export function osUserErrorToHttp(
  err: unknown,
  fallbackCode: string,
): { status: 400 | 403 | 404 | 409 | 503 | 504; code: string; message: string } {
  if (err instanceof PrivilegedTargetError) return { status: 403, code: "FORBIDDEN", message: err.message };
  if (err instanceof RemoteFailureError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof SshError) {
    const mapped = sshErrorToHttp(err);
    return { status: mapped.status, code: mapped.code ?? fallbackCode, message: mapped.message };
  }
  const message = err instanceof Error && err.message ? err.message : "OS user operation failed";
  return { status: 400, code: fallbackCode, message };
}

export interface OsUserWriteOptions {
  /** Caller holds `server:sudo`. When false, privileged targets are refused on the host. */
  allowPrivileged?: boolean;
}

// Exit status + stderr marker the in-script guards use (77 = EX_NOPERM).
const PRIVILEGED_EXIT = 77;
const PRIVILEGED_MARKER = "RACKMAP_PRIVILEGED_TARGET";
const PRIVILEGED_CASE_PATTERN = PRIVILEGED_OS_GROUPS.join("|");

/** OS-user writes: useradd/usermod -m/userdel -r can walk a large home directory. */
const WRITE_TIMEOUT_MS = 300_000;
const READ_TIMEOUT_MS = 60_000;

/** Validate an absolute path and return it single-quoted for the remote shell. */
function shellSafeAbsolutePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 255 || !ABSOLUTE_PATH_PATTERN.test(trimmed)) {
    throw new Error(`Invalid ${label} "${value}": expected an absolute path such as /bin/bash`);
  }
  if (trimmed.split("/").includes("..")) {
    throw new Error(`Invalid ${label} "${value}": path segments may not be ".."`);
  }
  return escapeShellArg(trimmed);
}

/** Validate every supplied group name, returning the trimmed non-empty ones. */
function validateGroupNames(groups: string[]): string[] {
  const clean = groups.map((g) => g.trim()).filter(Boolean);
  for (const group of clean) {
    if (group.length > 32 || !GROUP_NAME_PATTERN.test(group)) {
      throw new Error(`Invalid Linux group name "${group}"`);
    }
  }
  return clean;
}

/** A positive integer id, re-checked because it is interpolated into a root script. */
function safeNumericId(value: number, label: string): string {
  if (!Number.isInteger(value) || value <= 0 || value > 4_294_967_294) {
    throw new Error(`Invalid ${label} "${value}"`);
  }
  return String(value);
}

/**
 * chpasswd reads `user:password` LINES: a newline in the password would start a
 * second entry and set any account's password (e.g. root's).
 */
function assertSafePassword(password: string): void {
  if (/[\r\n\0]/.test(password)) {
    throw new Error("The password must not contain line breaks or NUL characters");
  }
}

/**
 * A sudoers entry is rule TEXT, not a shell word, and `visudo -cf` only checks
 * syntax. Without this allowlist a caller could grant itself root outright
 * (`ALL`), or close the generated rule and start a new one using `=` /
 * `NOPASSWD:` / `,`. Each entry must therefore be an absolute command path
 * followed by plain arguments — nothing else is accepted.
 */
function sanitizeSudoCommand(raw: string): string {
  const spec = raw.trim();
  if (!spec) {
    throw new Error("A sudo command entry must not be empty");
  }
  if (spec.length > 256) {
    throw new Error(`Sudo command "${raw}" is too long (maximum 256 characters)`);
  }
  if (SUDO_RESERVED_WORD_PATTERN.test(spec)) {
    throw new Error(`Sudo command "${raw}" may not contain the sudoers keyword ALL or a sudoers tag such as NOPASSWD`);
  }
  if (!SUDO_COMMAND_PATTERN.test(spec)) {
    throw new Error(
      `Invalid sudo command "${raw}": expected an absolute command path with plain arguments, e.g. "/usr/bin/systemctl restart nginx"`
    );
  }
  return spec;
}

type SudoGrantType = "all_nopasswd" | "all_passwd" | "custom";

/** Build the single sudoers line for a grant, validating any custom commands. */
function buildSudoersRuleLine(user: string, grant: SudoGrantType, customCommands?: string[]): string {
  if (grant === "all_nopasswd") return `${user} ALL=(ALL:ALL) NOPASSWD:ALL`;
  if (grant === "all_passwd") return `${user} ALL=(ALL:ALL) ALL`;

  const cmds = (customCommands || []).map(sanitizeSudoCommand);
  if (cmds.length === 0) {
    // Previously this fell back to "ALL", silently turning an empty custom list
    // into an unrestricted passwordless root grant.
    throw new Error('A custom sudo permission requires at least one command, e.g. "/usr/bin/systemctl restart nginx"');
  }
  return `${user} ALL=(ALL:ALL) NOPASSWD: ${cmds.join(", ")}`;
}

/**
 * Root-script fragment that installs a sudoers rule without the shell ever
 * seeing the rule text: the line travels as base64 and is decoded on the target,
 * so `$(...)`, backticks and backslashes cannot expand during the write.
 *
 * The scratch file comes from `mktemp` (a predictable name would allow a symlink
 * race between the write and the move), and `install` leaves the result
 * root:root 0440, which is what sudo requires. The script already runs as root,
 * so there is no inner `sudo` here.
 */
function buildSudoersWriteFragment(ruleLine: string, fileName: string): string {
  const payload = Buffer.from(`${ruleLine}\n`, "utf8").toString("base64");
  return (
    `(tmp=$(mktemp /tmp/rackmap_sudo.XXXXXXXX) && ` +
    `printf %s ${escapeShellArg(payload)} | base64 -d > "$tmp" && ` +
    `visudo -cf "$tmp" && ` +
    `install -o root -g root -m 0440 "$tmp" ${escapeShellArg(fileName)}; ` +
    `rc=$?; rm -f "$tmp" 2>/dev/null; exit $rc)`
  );
}

/**
 * `chpasswd` input as a root-script step. `printf` is a shell builtin, so the
 * `user:password` line never appears in any process's argv; the only copy on
 * the host is the 0600 script file, which is removed as soon as the run ends.
 */
function buildChpasswdStep(username: string, password: string): string {
  assertSafePassword(password);
  return `printf '%s\\n' ${escapeShellArg(`${username}:${password}`)} | chpasswd`;
}

/**
 * Refuse (exit 77 + marker) when `username` is root-equivalent on the host:
 * uid 0, a member of a privileged group (primary included — `id -Gn` lists it),
 * or holder of any sudoers rule. Runs as root, before any change is made.
 */
function buildPrivilegedUserGuard(username: string): string {
  const u = escapeShellArg(username);
  const refuse = `{ echo ${PRIVILEGED_MARKER} >&2; exit ${PRIVILEGED_EXIT}; }`;
  return [
    `if id ${u} >/dev/null 2>&1; then`,
    `  [ "$(id -u ${u})" = 0 ] && ${refuse}`,
    `  for g in $(id -Gn ${u} 2>/dev/null); do case "$g" in ${PRIVILEGED_CASE_PATTERN}) ${refuse};; esac; done`,
    `  if command -v sudo >/dev/null 2>&1 && LC_ALL=C sudo -n -l -U ${u} 2>/dev/null | grep -q 'may run the following'; then ${refuse}; fi`,
    `fi`,
  ].join("\n");
}

/** Refuse when a numeric primary gid resolves to a privileged group (e.g. `-g 27` = sudo on Debian). */
function buildPrivilegedGidGuard(gid: string): string {
  return [
    `g=$(getent group ${gid} 2>/dev/null | cut -d: -f1)`,
    `case "$g" in ${PRIVILEGED_CASE_PATTERN}) echo ${PRIVILEGED_MARKER} >&2; exit ${PRIVILEGED_EXIT};; esac`,
  ].join("\n");
}

/**
 * Assemble a root script: guards first, then each step; the first failing step
 * stops the script with its own exit status. PATH is pinned because a non-root
 * SSH user's PATH often lacks /usr/sbin (useradd, visudo, chpasswd).
 */
function buildRootScript(steps: string[], guards: string[] = []): string {
  return [
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; export PATH",
    ...guards,
    ...steps.map((s) => `${s} || exit $?`),
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Run a root script on the server and throw an operator-facing error unless it
 * succeeded. The SSH password (from the vault or the x-ssh-password override)
 * is handed to execAsRoot, which only writes it to sudo when `sudo -n` fails.
 */
async function runRootScript(
  serverId: number,
  script: string,
  overridePassword: string | undefined,
  failurePrefix: string,
): Promise<RemoteScriptResult> {
  const { client, password, passwordUnavailable } = await connectToServer(serverId, overridePassword);
  let result: RemoteScriptResult;
  try {
    result = await execAsRoot(client, script, password, { timeoutMs: WRITE_TIMEOUT_MS, maxOutputBytes: 256 * 1024 });
  } finally {
    client.end();
  }

  // Upload, sudo (a locked vault → 409 VAULT_LOCKED: unlock it or resend with
  // x-ssh-password) and timeouts carry their HTTP mapping to the route.
  const failure = remoteFailureToHttp(result, { passwordUnavailable });
  if (failure) throw new RemoteFailureError(failure, `${failurePrefix}: ${failure.message}`);
  if (result.exitCode === PRIVILEGED_EXIT && result.stderr.includes(PRIVILEGED_MARKER)) {
    throw new PrivilegedTargetError(
      "The target account or group is root-equivalent on this host; changing it requires the server:sudo permission"
    );
  }
  if (result.exitCode !== 0 || result.errorCode) {
    throw new Error(`${failurePrefix}: ${describeRemoteFailure(result)}`);
  }
  return result;
}

const LIST_USERS_SCRIPT = `
echo "===PASSWD==="
getent passwd 2>/dev/null || cat /etc/passwd
echo "===SUDOERS==="
cat /etc/sudoers /etc/sudoers.d/* 2>/dev/null || true
echo "===GROUPS==="
getent group 2>/dev/null || cat /etc/group
`;

export async function listOsUsers(serverId: number, overridePassword?: string): Promise<OsUserInfo[]> {
  const { client, password } = await connectToServer(serverId, overridePassword);
  let result: RemoteScriptResult;
  try {
    // Root reads /etc/sudoers; without usable sudo the listing still works and
    // simply shows whatever sudoers.d entries the SSH user can read.
    result = await execPreferRoot(client, LIST_USERS_SCRIPT, password, {
      timeoutMs: READ_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024 * 1024,
    });
  } finally {
    client.end();
  }
  if (result.errorCode === "UPLOAD_FAILED" || result.errorCode === "TIMEOUT") {
    throw new SshError("unreachable", `Failed to list OS users: ${describeRemoteFailure(result)}`);
  }
  try {
    return parseUsers(result.stdout);
  } catch (parseErr: any) {
    throw new Error(`Failed to parse users: ${parseErr.message}`);
  }
}

function parseUsers(output: string): OsUserInfo[] {
  const passwdIdx = output.indexOf("===PASSWD===");
  const sudoersIdx = output.indexOf("===SUDOERS===");
  const groupsIdx = output.indexOf("===GROUPS===");

  const passwdText = output.slice(passwdIdx + 12, sudoersIdx !== -1 ? sudoersIdx : undefined);
  const sudoersText = sudoersIdx !== -1 ? output.slice(sudoersIdx + 13, groupsIdx !== -1 ? groupsIdx : undefined) : "";
  const groupsText = groupsIdx !== -1 ? output.slice(groupsIdx + 12) : "";

  // Parse all user groups
  const userGroupsMap = new Map<string, string[]>();
  const sudoGroupMembers = new Set<string>();

  for (const line of groupsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(":");
    if (parts.length >= 4) {
      const groupName = parts[0]!;
      const members = parts[3]?.split(",").map((m) => m.trim()).filter(Boolean) || [];
      if (groupName === "sudo" || groupName === "wheel" || groupName === "admin") {
        for (const m of members) sudoGroupMembers.add(m);
      }
      for (const m of members) {
        if (!userGroupsMap.has(m)) userGroupsMap.set(m, []);
        userGroupsMap.get(m)!.push(groupName);
      }
    }
  }

  // Parse sudoers rules by user
  const sudoRulesByUser = new Map<string, string[]>();
  for (const line of sudoersText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("Defaults")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const user = parts[0]!.replace(/^%/, "");
      if (!sudoRulesByUser.has(user)) sudoRulesByUser.set(user, []);
      sudoRulesByUser.get(user)!.push(trimmed);
    }
  }

  const result: OsUserInfo[] = [];

  for (const line of passwdText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fields = trimmed.split(":");
    if (fields.length >= 7) {
      const username = fields[0]!;
      // Linux /etc/passwd: username:password:UID:GID:gecos:home:shell
      const uid = parseInt(fields[2] || "0", 10);
      const gid = parseInt(fields[3] || "0", 10);
      const homeDir = fields[5] || "";
      const shell = fields[6] || "";

      const isSystemUser = uid > 0 && uid < 1000;
      const inSudoGroup = sudoGroupMembers.has(username) || (uid === 0);
      const directRules = sudoRulesByUser.get(username) || [];
      const hasSudo = inSudoGroup || directRules.length > 0;

      const userGroups = userGroupsMap.get(username) || [];
      if (inSudoGroup && !userGroups.includes("sudo")) {
        userGroups.push("sudo");
      }

      result.push({
        username,
        uid: isNaN(uid) ? 0 : uid,
        gid: isNaN(gid) ? 0 : gid,
        homeDir,
        shell,
        isSystemUser,
        groups: userGroups,
        hasSudo,
        sudoRules: directRules,
      });
    }
  }

  // Sort interactive users first, then by UID
  return result.sort((a, b) => {
    if (a.isSystemUser !== b.isSystemUser) return a.isSystemUser ? 1 : -1;
    return a.uid - b.uid;
  });
}

export async function updateSudoPermission(
  serverId: number,
  input: SudoPermissionInput,
  ctx: AuditCtx = {},
  overridePassword?: string
): Promise<{ ok: boolean; message: string }> {
  const targetUser = sanitizeUsername(input.username);
  const fileName = `/etc/sudoers.d/rackmap_${targetUser}`;

  // Built and validated before the SSH session is opened so invalid input never
  // leaves a connection dangling.
  const step =
    input.permissionType === "none"
      ? `rm -f ${escapeShellArg(fileName)}`
      : buildSudoersWriteFragment(
          buildSudoersRuleLine(targetUser, input.permissionType, input.customCommands),
          fileName
        );

  await runRootScript(serverId, buildRootScript([step]), overridePassword, "Failed to update sudoers rule");

  await writeAudit({
    ctx,
    category: "security",
    action: "server.sudo_permission",
    entity: "server",
    entityId: String(serverId),
    after: { targetUser, permissionType: input.permissionType, customCommands: input.customCommands },
  });
  return { ok: true, message: `Successfully updated sudo permission for ${targetUser}` };
}


export async function createOsUser(
  serverId: number,
  input: CreateOsUserInput,
  ctx: AuditCtx = {},
  overridePassword?: string,
  opts: OsUserWriteOptions = {}
): Promise<{ ok: boolean; message: string }> {
  const username = sanitizeUsername(input.username);

  // Built and validated before the SSH session is opened: every value below is
  // interpolated into a script that runs as root on the managed host.
  const flags: string[] = [];
  const guards: string[] = [];
  if (input.createHome !== false) flags.push("-m");
  if (input.shell) flags.push(`-s ${shellSafeAbsolutePath(input.shell, "shell")}`);
  if (input.homeDir) flags.push(`-d ${shellSafeAbsolutePath(input.homeDir, "home directory")}`);
  if (input.isSystemUser) flags.push("-r");
  if (input.uid) flags.push(`-u ${safeNumericId(input.uid, "uid")}`);
  if (input.gid) {
    const gid = safeNumericId(input.gid, "gid");
    flags.push(`-g ${gid}`);
    if (!opts.allowPrivileged) guards.push(buildPrivilegedGidGuard(gid));
  }
  if (input.groups && input.groups.length > 0) {
    const cleanGroups = validateGroupNames(input.groups).join(",");
    if (cleanGroups) flags.push(`-G ${escapeShellArg(cleanGroups)}`);
  }

  const steps = [`useradd ${flags.join(" ")} ${escapeShellArg(username)}`];
  if (input.password) steps.push(buildChpasswdStep(username, input.password));

  if (input.sudoType && input.sudoType !== "none") {
    const fileName = `/etc/sudoers.d/rackmap_${username}`;
    steps.push(buildSudoersWriteFragment(buildSudoersRuleLine(username, input.sudoType, input.customCommands), fileName));
  }

  await runRootScript(serverId, buildRootScript(steps, guards), overridePassword, `Failed to create OS user ${username}`);

  await writeAudit({
    ctx,
    category: "security",
    action: "server.os_user_create",
    entity: "server",
    entityId: String(serverId),
    after: {
      username,
      shell: input.shell || "/bin/bash",
      homeDir: input.homeDir || `/home/${username}`,
      groups: input.groups,
      sudoType: input.sudoType || "none",
      isSystemUser: input.isSystemUser,
      passwordSet: !!input.password,
    },
  });
  return { ok: true, message: `Successfully created user account ${username}` };
}

export async function updateOsUser(
  serverId: number,
  rawUsername: string,
  input: UpdateOsUserInput,
  ctx: AuditCtx = {},
  overridePassword?: string,
  opts: OsUserWriteOptions = {}
): Promise<{ ok: boolean; message: string }> {
  const username = sanitizeUsername(rawUsername);
  const safeUsername = escapeShellArg(username);

  // Built and validated before the SSH session is opened: every value below is
  // interpolated into a script that runs as root on the managed host.
  const steps: string[] = [];

  if (input.shell) {
    steps.push(`usermod -s ${shellSafeAbsolutePath(input.shell, "shell")} ${safeUsername}`);
  }
  if (input.homeDir) {
    steps.push(`usermod -d ${shellSafeAbsolutePath(input.homeDir, "home directory")} -m ${safeUsername}`);
  }
  if (input.groups !== undefined) {
    const cleanGroups = validateGroupNames(input.groups).join(",");
    steps.push(`usermod -G ${escapeShellArg(cleanGroups)} ${safeUsername}`);
  }
  if (input.password) {
    steps.push(buildChpasswdStep(username, input.password));
  }
  if (input.isLocked === true) {
    steps.push(`usermod -L ${safeUsername}`);
  } else if (input.isLocked === false) {
    steps.push(`usermod -U ${safeUsername}`);
  }

  if (input.sudoType !== undefined) {
    const fileName = `/etc/sudoers.d/rackmap_${username}`;
    if (input.sudoType === "none") {
      steps.push(`rm -f ${escapeShellArg(fileName)}`);
    } else {
      steps.push(
        buildSudoersWriteFragment(buildSudoersRuleLine(username, input.sudoType, input.customCommands), fileName)
      );
    }
  }

  if (steps.length === 0) {
    return { ok: true, message: "No changes requested" };
  }

  // Without server:sudo, any change to an account that is already
  // root-equivalent (new password, shell, lock state…) is refused on the host.
  const guards = opts.allowPrivileged ? [] : [buildPrivilegedUserGuard(username)];
  await runRootScript(serverId, buildRootScript(steps, guards), overridePassword, `Failed to update user ${username}`);

  // Never audit the password itself.
  const { password: _password, ...auditedInput } = input;
  await writeAudit({
    ctx,
    category: "security",
    action: "server.os_user_update",
    entity: "server",
    entityId: String(serverId),
    after: { username, ...auditedInput, ...(input.password ? { passwordChanged: true } : {}) },
  });
  return { ok: true, message: `Successfully updated user account ${username}` };
}

export async function deleteOsUser(
  serverId: number,
  rawUsername: string,
  input: DeleteOsUserInput,
  ctx: AuditCtx = {},
  overridePassword?: string,
  opts: OsUserWriteOptions = {}
): Promise<{ ok: boolean; message: string }> {
  const username = sanitizeUsername(rawUsername);

  if (username.toLowerCase() === "root") {
    throw new Error("Cannot delete root user account");
  }

  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { username: true },
  });
  if (server && server.username === username) {
    throw new Error("Cannot delete the active SSH administration account for this server");
  }

  const flags: string[] = [];
  if (input.removeHome !== false) flags.push("-r");
  if (input.force === true) flags.push("-f");

  const steps = [
    `userdel ${flags.join(" ")} ${escapeShellArg(username)}`,
    `rm -f ${escapeShellArg(`/etc/sudoers.d/rackmap_${username}`)}`,
  ];
  // Without server:sudo, removing an account that is root-equivalent on the
  // host (e.g. another administrator) is refused there, like updates are.
  const guards = opts.allowPrivileged ? [] : [buildPrivilegedUserGuard(username)];
  await runRootScript(serverId, buildRootScript(steps, guards), overridePassword, `Failed to delete user ${username}`);

  await writeAudit({
    ctx,
    category: "security",
    action: "server.os_user_delete",
    entity: "server",
    entityId: String(serverId),
    after: { username, removeHome: input.removeHome, force: input.force },
  });
  return { ok: true, message: `Successfully deleted user account ${username}` };
}
