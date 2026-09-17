import { connectToServer, buildSudoCommand, SshError } from "./ssh.service.js";
import { writeAudit, type AuditCtx } from "../lib/audit.js";
import type { OsUserInfo, SudoPermissionInput } from "@inv/shared";

function sanitizeUsername(username: string): string {
  const sanitized = username.trim();
  if (!/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$/.test(sanitized)) {
    throw new Error("Invalid Linux username format");
  }
  return sanitized;
}

export async function listOsUsers(serverId: number): Promise<OsUserInfo[]> {
  const { client, password } = await connectToServer(serverId);
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

  // Parse sudo groups
  const sudoGroupMembers = new Set<string>();
  for (const line of groupsText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("sudo:") || trimmed.startsWith("wheel:") || trimmed.startsWith("admin:")) {
      const parts = trimmed.split(":");
      const members = parts[3]?.split(",").map((m) => m.trim()).filter(Boolean) || [];
      for (const m of members) sudoGroupMembers.add(m);
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
      const uid = parseInt(fields[1] || fields[2] || "0", 10);
      const gid = parseInt(fields[3] || "0", 10);
      const homeDir = fields[5] || "";
      const shell = fields[6] || "";

      const isSystemUser = uid > 0 && uid < 1000;
      const inSudoGroup = sudoGroupMembers.has(username) || (uid === 0);
      const directRules = sudoRulesByUser.get(username) || [];
      const hasSudo = inSudoGroup || directRules.length > 0;

      const userGroups: string[] = [];
      if (inSudoGroup) userGroups.push("sudo");

      result.push({
        username,
        uid,
        gid,
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
  ctx: AuditCtx = {}
): Promise<{ ok: boolean; message: string }> {
  const targetUser = sanitizeUsername(input.username);
  const { client } = await connectToServer(serverId);

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
