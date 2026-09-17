import { connectToServer, buildSudoCommand, SshError } from "./ssh.service.js";
import type { AutoUpdateStatus, AutoUpdateActionInput } from "@inv/shared";

export async function getAutoUpdateStatus(serverId: number): Promise<AutoUpdateStatus> {
  const { client } = await connectToServer(serverId);

  const script = `
if which unattended-upgrade >/dev/null 2>&1; then
  PKG="apt"
elif which dnf-automatic >/dev/null 2>&1; then
  PKG="dnf"
else
  PKG="other"
fi
echo "PKG:$PKG"

ACTIVE=$(systemctl is-active unattended-upgrades 2>/dev/null || echo "inactive")
ENABLED=$(systemctl is-enabled unattended-upgrades 2>/dev/null || echo "disabled")
echo "ACTIVE:$ACTIVE"
echo "ENABLED:$ENABLED"

CONF=$(cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null || cat /etc/apt/apt.conf.d/10periodic 2>/dev/null || echo "")
echo "CONF_START"
echo "$CONF"
echo "CONF_END"

LOG=$(tail -n 15 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null || echo "No upgrade history log found.")
echo "LOG_START"
echo "$LOG"
echo "LOG_END"
`;

  return new Promise((resolve, reject) => {
    let stdout = "";
    client.exec(script, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to check auto-update status: ${err.message}`));
      }

      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      stream.on("close", () => {
        client.end();

        const pkgMatch = stdout.match(/PKG:(apt|dnf|other)/);
        const pkg = (pkgMatch ? pkgMatch[1] : "other") as "apt" | "dnf" | "yum" | "other";
        const installed = pkg !== "other";

        const activeMatch = stdout.match(/ACTIVE:(active|inactive)/);
        const active = activeMatch ? activeMatch[1] === "active" : false;

        const enabledMatch = stdout.match(/ENABLED:(enabled|disabled)/);
        const serviceEnabled = enabledMatch ? enabledMatch[1] === "enabled" : false;

        const confPart = stdout.substring(stdout.indexOf("CONF_START"), stdout.indexOf("CONF_END"));
        const updatePackageLists = confPart.includes('Update-Package-Lists "1"');
        const unattendedUpgrade = confPart.includes('Unattended-Upgrade "1"');

        const isFullyEnabled = (serviceEnabled || active) && unattendedUpgrade;

        let lastLog: string | null = null;
        if (stdout.includes("LOG_START") && stdout.includes("LOG_END")) {
          lastLog = stdout
            .substring(stdout.indexOf("LOG_START") + 9, stdout.indexOf("LOG_END"))
            .trim();
        }

        resolve({
          installed,
          enabled: isFullyEnabled,
          active,
          serviceStatus: active ? "active" : serviceEnabled ? "enabled" : "disabled",
          packageManager: pkg,
          updatePackageLists,
          unattendedUpgrade,
          lastLogSnippet: lastLog,
        });
      });
    });
  });
}

export async function updateAutoUpdateStatus(
  serverId: number,
  input: AutoUpdateActionInput
): Promise<{ success: boolean; message: string }> {
  const { client, password } = await connectToServer(serverId);
  const action = input.action;

  let rawCmd = "";
  if (action === "enable") {
    rawCmd = `
if ! which unattended-upgrade >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq unattended-upgrades
fi
mkdir -p /etc/apt/apt.conf.d
printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades 2>/dev/null || true
echo "SUCCESS_ENABLE"
`;
  } else if (action === "disable") {
    rawCmd = `
mkdir -p /etc/apt/apt.conf.d
printf 'APT::Periodic::Update-Package-Lists "0";\\nAPT::Periodic::Unattended-Upgrade "0";\\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl stop unattended-upgrades 2>/dev/null || true
systemctl disable unattended-upgrades 2>/dev/null || true
echo "SUCCESS_DISABLE"
`;
  } else if (action === "remove") {
    rawCmd = `
export DEBIAN_FRONTEND=noninteractive
apt-get purge -y -qq unattended-upgrades 2>/dev/null || true
rm -f /etc/apt/apt.conf.d/20auto-upgrades
echo "SUCCESS_REMOVE"
`;
  }

  const sudoExec = buildSudoCommand(`sh -c "${rawCmd.replace(/"/g, '\\"')}"`, password);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    client.exec(sudoExec, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to execute auto-update change: ${err.message}`));
      }

      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      stream.on("close", (code: number | null) => {
        client.end();
        if (code === 0 || stdout.includes("SUCCESS_")) {
          const msg =
            action === "enable"
              ? "Unattended Upgrades auto-update successfully enabled and activated on host."
              : action === "disable"
              ? "Unattended Upgrades disabled (system will not perform automated background updates)."
              : "Unattended Upgrades package purged from host.";
          resolve({ success: true, message: msg });
        } else {
          reject(new Error(`Failed to configure unattended-upgrades (exit code ${code}): ${stderr || stdout}`));
        }
      });
    });
  });
}
