import { prisma } from "../db.js";
import { connectToServer, buildSudoCommand, SshError } from "./ssh.service.js";
import { escapeShellArg } from "./shell-escape.js";
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
 * Install a sudoers rule without the shell ever seeing the rule text: the line
 * travels as base64 and is decoded on the target, so `$(...)`, backticks and
 * backslashes cannot expand during the write (the old `echo "<rule>"` form ran
 * them as root).
 *
 * The scratch file comes from `mktemp` — the previous fixed
 * `/tmp/rackmap_sudo_<Date.now()>_<Math.random()>` name was predictable enough
 * for a local attacker to win a symlink race between the write and the move.
 * `install` runs as root so the result is root:root 0440, which is what sudo
 * requires (the old `mv` left the file owned by the SSH user).
 */
function buildSudoersWriteCommand(ruleLine: string, fileName: string): string {
  const payload = Buffer.from(`${ruleLine}\n`, "utf8").toString("base64");
  return (
    `(tmp=$(mktemp /tmp/rackmap_sudo.XXXXXXXX) && ` +
    `printf %s ${escapeShellArg(payload)} | base64 -d > "$tmp" && ` +
    `sudo visudo -cf "$tmp" && ` +
    `sudo install -o root -g root -m 0440 "$tmp" ${escapeShellArg(fileName)}; ` +
    `rc=$?; rm -f "$tmp" 2>/dev/null; exit $rc)`
  );
}

export async function listOsUsers(serverId: number, overridePassword?: string): Promise<OsUserInfo[]> {
  const { client, password } = await connectToServer(serverId, overridePassword);
  const sudoCat = buildSudoCommand("cat /etc/sudoers /etc/sudoers.d/*", password);

  const script = `
echo "===PASSWD==="
getent passwd 2>/dev/null || cat /etc/passwd
echo "===SUDOERS==="
${sudoCat} 2>/dev/null || cat /etc/sudoers.d/* 2>/dev/null || echo ""
echo "===GROUPS==="
getent group 2>/dev/null || cat /etc/group
`;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    client.exec(script, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to list OS users: ${err.message}`));
      }

      stream
        .on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        })
        .stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

      stream.on("close", () => {
        client.end();
        try {
          const users = parseUsers(stdout);
          resolve(users);
        } catch (parseErr: any) {
          reject(new Error(`Failed to parse users: ${parseErr.message}`));
        }
      });
    });
  });
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
  const execCmd =
    input.permissionType === "none"
      ? `sudo rm -f ${escapeShellArg(fileName)}`
      : buildSudoersWriteCommand(
          buildSudoersRuleLine(targetUser, input.permissionType, input.customCommands),
          fileName
        );

  const { client, password } = await connectToServer(serverId, overridePassword);

  return new Promise((resolve, reject) => {
    client.exec(execCmd, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to execute sudo update: ${err.message}`));
      }

      let stderr = "";
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      stream.on("close", async (code: number | null) => {
        client.end();
        if (code === 0) {
          await writeAudit({
            ctx,
            category: "security",
            action: "server.sudo_permission",
            entity: "server",
            entityId: String(serverId),
            after: { targetUser, permissionType: input.permissionType, customCommands: input.customCommands },
          });
          resolve({ ok: true, message: `Successfully updated sudo permission for ${targetUser}` });
        } else {
          reject(new Error(`Failed to update sudoers rule. visudo validation error: ${stderr || "Exit code " + code}`));
        }
      });
    });
  });
}


export async function createOsUser(
  serverId: number,
  input: CreateOsUserInput,
  ctx: AuditCtx = {},
  overridePassword?: string
): Promise<{ ok: boolean; message: string }> {
  const username = sanitizeUsername(input.username);

  // Built and validated before the SSH session is opened: every value below is
  // interpolated into a command that runs as root on the managed host.
  const flags: string[] = [];
  if (input.createHome !== false) flags.push("-m");
  if (input.shell) flags.push(`-s ${shellSafeAbsolutePath(input.shell, "shell")}`);
  if (input.homeDir) flags.push(`-d ${shellSafeAbsolutePath(input.homeDir, "home directory")}`);
  if (input.isSystemUser) flags.push("-r");
  if (input.uid) flags.push(`-u ${input.uid}`);
  if (input.gid) flags.push(`-g ${input.gid}`);
  if (input.groups && input.groups.length > 0) {
    const cleanGroups = validateGroupNames(input.groups).join(",");
    if (cleanGroups) flags.push(`-G ${escapeShellArg(cleanGroups)}`);
  }

  let execCmd = `sudo useradd ${flags.join(" ")} ${escapeShellArg(username)}`;
  if (input.password) {
    execCmd += ` && echo ${escapeShellArg(`${username}:${input.password}`)} | sudo chpasswd`;
  }

  if (input.sudoType && input.sudoType !== "none") {
    const fileName = `/etc/sudoers.d/rackmap_${username}`;
    execCmd += ` && ${buildSudoersWriteCommand(
      buildSudoersRuleLine(username, input.sudoType, input.customCommands),
      fileName
    )}`;
  }

  const { client, password } = await connectToServer(serverId, overridePassword);

  return new Promise((resolve, reject) => {
    client.exec(execCmd, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to execute create user: ${err.message}`));
      }

      let stderr = "";
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      stream.on("close", async (code: number | null) => {
        client.end();
        if (code === 0) {
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
            },
          });
          resolve({ ok: true, message: `Successfully created user account ${username}` });
        } else {
          reject(new Error(`Failed to create OS user ${username}: ${stderr || "Exit code " + code}`));
        }
      });
    });
  });
}

export async function updateOsUser(
  serverId: number,
  rawUsername: string,
  input: UpdateOsUserInput,
  ctx: AuditCtx = {},
  overridePassword?: string
): Promise<{ ok: boolean; message: string }> {
  const username = sanitizeUsername(rawUsername);
  const safeUsername = escapeShellArg(username);

  // Built and validated before the SSH session is opened: every value below is
  // interpolated into a command that runs as root on the managed host.
  const steps: string[] = [];

  if (input.shell) {
    steps.push(`sudo usermod -s ${shellSafeAbsolutePath(input.shell, "shell")} ${safeUsername}`);
  }
  if (input.homeDir) {
    steps.push(`sudo usermod -d ${shellSafeAbsolutePath(input.homeDir, "home directory")} -m ${safeUsername}`);
  }
  if (input.groups !== undefined) {
    const cleanGroups = validateGroupNames(input.groups).join(",");
    steps.push(`sudo usermod -G ${escapeShellArg(cleanGroups)} ${safeUsername}`);
  }
  if (input.password) {
    steps.push(`echo ${escapeShellArg(`${username}:${input.password}`)} | sudo chpasswd`);
  }
  if (input.isLocked === true) {
    steps.push(`sudo usermod -L ${safeUsername}`);
  } else if (input.isLocked === false) {
    steps.push(`sudo usermod -U ${safeUsername}`);
  }

  if (input.sudoType !== undefined) {
    const fileName = `/etc/sudoers.d/rackmap_${username}`;
    if (input.sudoType === "none") {
      steps.push(`sudo rm -f ${escapeShellArg(fileName)}`);
    } else {
      steps.push(
        buildSudoersWriteCommand(buildSudoersRuleLine(username, input.sudoType, input.customCommands), fileName)
      );
    }
  }

  const { client, password } = await connectToServer(serverId, overridePassword);

  return new Promise((resolve, reject) => {
    if (steps.length === 0) {
      client.end();
      return resolve({ ok: true, message: "No changes requested" });
    }

    const execCmd = steps.join(" && ");

    client.exec(execCmd, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to execute update user: ${err.message}`));
      }

      let stderr = "";
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      stream.on("close", async (code: number | null) => {
        client.end();
        if (code === 0) {
          await writeAudit({
            ctx,
            category: "security",
            action: "server.os_user_update",
            entity: "server",
            entityId: String(serverId),
            after: { username, ...input },
          });
          resolve({ ok: true, message: `Successfully updated user account ${username}` });
        } else {
          reject(new Error(`Failed to update user ${username}: ${stderr || "Exit code " + code}`));
        }
      });
    });
  });
}

export async function deleteOsUser(
  serverId: number,
  rawUsername: string,
  input: DeleteOsUserInput,
  ctx: AuditCtx = {},
  overridePassword?: string
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

  const { client, password } = await connectToServer(serverId, overridePassword);

  return new Promise((resolve, reject) => {
    const flags: string[] = [];
    if (input.removeHome !== false) flags.push("-r");
    if (input.force) flags.push("-f");

    const execCmd = `sudo userdel ${flags.join(" ")} ${escapeShellArg(username)} && sudo rm -f ${escapeShellArg(
      `/etc/sudoers.d/rackmap_${username}`
    )}`;

    client.exec(execCmd, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to execute delete user: ${err.message}`));
      }

      let stderr = "";
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      stream.on("close", async (code: number | null) => {
        client.end();
        if (code === 0) {
          await writeAudit({
            ctx,
            category: "security",
            action: "server.os_user_delete",
            entity: "server",
            entityId: String(serverId),
            after: { username, removeHome: input.removeHome, force: input.force },
          });
          resolve({ ok: true, message: `Successfully deleted user account ${username}` });
        } else {
          reject(new Error(`Failed to delete user ${username}: ${stderr || "Exit code " + code}`));
        }
      });
    });
  });
}
