import { prisma } from "../db.js";
import { connectToServer, buildSudoCommand, SshError } from "./ssh.service.js";
import { writeAudit, type AuditCtx } from "../lib/audit.js";
import type { OsUserInfo, SudoPermissionInput, CreateOsUserInput, UpdateOsUserInput, DeleteOsUserInput } from "@inv/shared";

function sanitizeUsername(username: string): string {
  const sanitized = username.trim();
  if (!/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$/.test(sanitized)) {
    throw new Error("Invalid Linux username format");
  }
  return sanitized;
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
  const { client, password } = await connectToServer(serverId, overridePassword);

  return new Promise((resolve, reject) => {
    const fileName = `/etc/sudoers.d/rackmap_${targetUser}`;
    let execCmd = "";

    if (input.permissionType === "none") {
      execCmd = `sudo rm -f ${fileName}`;
    } else {
      let ruleLine = "";
      if (input.permissionType === "all_nopasswd") {
        ruleLine = `${targetUser} ALL=(ALL:ALL) NOPASSWD:ALL`;
      } else if (input.permissionType === "all_passwd") {
        ruleLine = `${targetUser} ALL=(ALL:ALL) ALL`;
      } else if (input.permissionType === "custom") {
        const cmds = input.customCommands && input.customCommands.length > 0 ? input.customCommands.join(", ") : "ALL";
        ruleLine = `${targetUser} ALL=(ALL:ALL) NOPASSWD: ${cmds}`;
      }

      const tmpFile = `/tmp/rackmap_sudo_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      execCmd = `
echo "${ruleLine}" > ${tmpFile} && \
sudo visudo -cf ${tmpFile} && \
sudo mv ${tmpFile} ${fileName} && \
sudo chmod 0440 ${fileName} || (rm -f ${tmpFile}; exit 1)
`;
    }

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
  const { client, password } = await connectToServer(serverId, overridePassword);

  return new Promise((resolve, reject) => {
    const flags: string[] = [];
    if (input.createHome !== false) flags.push("-m");
    if (input.shell) flags.push(`-s ${input.shell}`);
    if (input.homeDir) flags.push(`-d "${input.homeDir}"`);
    if (input.isSystemUser) flags.push("-r");
    if (input.uid) flags.push(`-u ${input.uid}`);
    if (input.gid) flags.push(`-g ${input.gid}`);
    if (input.groups && input.groups.length > 0) {
      const cleanGroups = input.groups.map((g) => g.trim()).filter(Boolean).join(",");
      if (cleanGroups) flags.push(`-G ${cleanGroups}`);
    }

    let execCmd = `sudo useradd ${flags.join(" ")} ${username}`;
    if (input.password) {
      const safePwd = input.password.replace(/'/g, "'\\''");
      execCmd += ` && echo '${username}:${safePwd}' | sudo chpasswd`;
    }

    if (input.sudoType && input.sudoType !== "none") {
      const fileName = `/etc/sudoers.d/rackmap_${username}`;
      let ruleLine = "";
      if (input.sudoType === "all_nopasswd") {
        ruleLine = `${username} ALL=(ALL:ALL) NOPASSWD:ALL`;
      } else if (input.sudoType === "all_passwd") {
        ruleLine = `${username} ALL=(ALL:ALL) ALL`;
      } else if (input.sudoType === "custom") {
        const cmds = input.customCommands && input.customCommands.length > 0 ? input.customCommands.join(", ") : "ALL";
        ruleLine = `${username} ALL=(ALL:ALL) NOPASSWD: ${cmds}`;
      }

      const tmpFile = `/tmp/rackmap_sudo_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      execCmd += ` && (echo "${ruleLine}" > ${tmpFile} && sudo visudo -cf ${tmpFile} && sudo mv ${tmpFile} ${fileName} && sudo chmod 0440 ${fileName})`;
    }

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
  const { client, password } = await connectToServer(serverId, overridePassword);

  return new Promise((resolve, reject) => {
    const steps: string[] = [];

    if (input.shell) {
      steps.push(`sudo usermod -s ${input.shell} ${username}`);
    }
    if (input.homeDir) {
      steps.push(`sudo usermod -d "${input.homeDir}" -m ${username}`);
    }
    if (input.groups !== undefined) {
      const cleanGroups = input.groups.map((g) => g.trim()).filter(Boolean).join(",");
      steps.push(`sudo usermod -G "${cleanGroups}" ${username}`);
    }
    if (input.password) {
      const safePwd = input.password.replace(/'/g, "'\\''");
      steps.push(`echo '${username}:${safePwd}' | sudo chpasswd`);
    }
    if (input.isLocked === true) {
      steps.push(`sudo usermod -L ${username}`);
    } else if (input.isLocked === false) {
      steps.push(`sudo usermod -U ${username}`);
    }

    if (input.sudoType !== undefined) {
      const fileName = `/etc/sudoers.d/rackmap_${username}`;
      if (input.sudoType === "none") {
        steps.push(`sudo rm -f ${fileName}`);
      } else {
        let ruleLine = "";
        if (input.sudoType === "all_nopasswd") {
          ruleLine = `${username} ALL=(ALL:ALL) NOPASSWD:ALL`;
        } else if (input.sudoType === "all_passwd") {
          ruleLine = `${username} ALL=(ALL:ALL) ALL`;
        } else if (input.sudoType === "custom") {
          const cmds = input.customCommands && input.customCommands.length > 0 ? input.customCommands.join(", ") : "ALL";
          ruleLine = `${username} ALL=(ALL:ALL) NOPASSWD: ${cmds}`;
        }
        const tmpFile = `/tmp/rackmap_sudo_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        steps.push(`(echo "${ruleLine}" > ${tmpFile} && sudo visudo -cf ${tmpFile} && sudo mv ${tmpFile} ${fileName} && sudo chmod 0440 ${fileName})`);
      }
    }

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

    const execCmd = `sudo userdel ${flags.join(" ")} ${username} && sudo rm -f /etc/sudoers.d/rackmap_${username}`;

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
