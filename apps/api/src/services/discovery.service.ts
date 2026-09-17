import { connectToServer, SshError } from "./ssh.service.js";
import { prisma } from "../db.js";
import { writeAudit, type AuditCtx } from "../lib/audit.js";
import type { ServerHardwareInfo, HardwareDiskInfo } from "@inv/shared";

const DISCOVERY_SCRIPT = `
echo "===CPU==="
lscpu 2>/dev/null || cat /proc/cpuinfo
echo "===MEM==="
cat /proc/meminfo
echo "===OS==="
cat /etc/os-release
echo "===GPU==="
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,count --format=csv,noheader 2>/dev/null
elif [ -d /sys/class/drm ]; then
  for _d in /sys/class/drm/card*/device; do
    [ -f "$_d/gpu_busy_percent" ] && echo "AMD Radeon Graphics (amdgpu), 1" && break
  done
elif command -v rocm-smi >/dev/null 2>&1; then
  rocm-smi --showproductname 2>/dev/null | awk -F: '/Card series/{print $2", 1"}'
elif command -v xpu-smi >/dev/null 2>&1; then
  echo "Intel Data Center GPU, 1"
fi || (lspci 2>/dev/null | grep -iE 'vga|3d|display') || echo "NONE"
echo "===DISK==="
lsblk -b -d -o NAME,SIZE,TYPE,MODEL 2>/dev/null || df -h
echo "===UPTIME==="
uptime -p 2>/dev/null || uptime
echo "===UNAME==="
uname -s -r -m
`;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0GB";
  const gb = Math.round(bytes / (1024 * 1024 * 1024));
  return `${gb}GB`;
}

function parseSection(fullOutput: string, sectionName: string): string {
  const marker = `===${sectionName}===`;
  const start = fullOutput.indexOf(marker);
  if (start === -1) return "";
  const nextSection = fullOutput.indexOf("===", start + marker.length);
  if (nextSection === -1) {
    return fullOutput.slice(start + marker.length).trim();
  }
  return fullOutput.slice(start + marker.length, nextSection).trim();
}

export function parseDiscoveryOutput(output: string, hostname: string): ServerHardwareInfo {
  // 1. CPU
  const cpuText = parseSection(output, "CPU");
  let cpuModel = "Generic CPU";
  let cpuCores = 1;
  let cpuThreads = 1;

  for (const line of cpuText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Model name:") || trimmed.startsWith("model name\t:")) {
      cpuModel = trimmed.split(":")[1]?.trim() || cpuModel;
    } else if (trimmed.startsWith("CPU(s):")) {
      const parsed = parseInt(trimmed.split(":")[1]?.trim() || "", 10);
      if (!isNaN(parsed) && parsed > 0) cpuCores = parsed;
    } else if (trimmed.startsWith("Thread(s) per core:")) {
      const parsed = parseInt(trimmed.split(":")[1]?.trim() || "", 10);
      if (!isNaN(parsed) && parsed > 0) cpuThreads = parsed * cpuCores;
    }
  }

  // 2. RAM
  const memText = parseSection(output, "MEM");
  let ramBytes = 0;
  for (const line of memText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("MemTotal:")) {
      const parts = trimmed.split(/\s+/);
      const kb = parseInt(parts[1] || "", 10);
      if (!isNaN(kb) && kb > 0) {
        ramBytes = kb * 1024;
      }
      break;
    }
  }
  const ramFormatted = formatBytes(ramBytes);

  // 3. OS
  const osText = parseSection(output, "OS");
  let osName = "Linux";
  for (const line of osText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("PRETTY_NAME=")) {
      osName = trimmed.replace(/^PRETTY_NAME=["']?/, "").replace(/["']?$/, "");
      break;
    }
  }

  // 4. GPU
  const gpuText = parseSection(output, "GPU");
  let gpuCount = 0;
  let gpuModel: string | null = null;
  if (gpuText && gpuText !== "NONE") {
    const lines = gpuText.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.includes(",")) {
        // nvidia-smi csv output: "NVIDIA GeForce RTX 3090, 1"
        const [name, countStr] = line.split(",");
        if (name) {
          gpuModel = name.trim();
          const count = parseInt(countStr?.trim() || "1", 10);
          gpuCount += isNaN(count) ? 1 : count;
        }
      } else if (line.toLowerCase().includes("vga") || line.toLowerCase().includes("nvidia") || line.toLowerCase().includes("amd")) {
        gpuCount++;
        if (!gpuModel) {
          gpuModel = line.split(":").pop()?.trim() || line;
        }
      }
    }
  }

  // 5. Disks
  const diskText = parseSection(output, "DISK");
  const disks: HardwareDiskInfo[] = [];
  const diskLines = diskText.split("\n").filter((l) => l.trim().length > 0);
  if (diskLines.length > 1 && diskLines[0]?.includes("NAME")) {
    for (let i = 1; i < diskLines.length; i++) {
      const parts = diskLines[i]!.trim().split(/\s+/);
      if (parts.length >= 3) {
        const name = parts[0]!;
        const rawBytes = parseInt(parts[1] || "0", 10);
        const sizeFormatted = isNaN(rawBytes) || rawBytes <= 0 ? parts[1]! : formatBytes(rawBytes);
        const type = parts[2]!;
        const model = parts.slice(3).join(" ") || "Disk";
        if (type === "disk" || type === "rom") {
          disks.push({ name, size: sizeFormatted, type, model });
        }
      }
    }
  }

  // 6. Uptime & Kernel
  const uptimeText = parseSection(output, "UPTIME");
  const uptime = uptimeText.replace(/^up\s+/, "") || "Unknown";

  const unameText = parseSection(output, "UNAME");
  const unameParts = unameText.split(/\s+/);
  const kernel = unameParts.length >= 2 ? `${unameParts[0]} ${unameParts[1]}` : "Linux";
  const arch = unameParts.length >= 3 ? unameParts[2]! : "x86_64";

  return {
    cpuModel,
    cpuCores,
    cpuThreads,
    ramBytes,
    ramFormatted,
    osName,
    kernel,
    arch,
    hostname,
    gpuCount,
    gpuModel,
    disks,
    uptime,
  };
}

/** Execute remote SSH discovery on a server */
export async function discoverServerHardware(serverId: number): Promise<ServerHardwareInfo> {
  const { client, target } = await connectToServer(serverId);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    client.exec(DISCOVERY_SCRIPT, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to execute discovery command: ${err.message}`));
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
          const info = parseDiscoveryOutput(stdout, target.hostname);
          resolve(info);
        } catch (parseErr: any) {
          reject(new Error(`Failed to parse hardware information: ${parseErr.message}`));
        }
      });
    });
  });
}

/** Auto-discover and automatically update the Server database record */
export async function autoDiscoverAndApply(serverId: number, ctx: AuditCtx = {}): Promise<ServerHardwareInfo> {
  const info = await discoverServerHardware(serverId);

  // Automatically update server details in database
  await prisma.server.update({
    where: { id: serverId },
    data: {
      cpu: `${info.cpuCores} Cores - ${info.cpuModel}`.slice(0, 255),
      ram: info.ramFormatted,
      gpuCount: info.gpuCount,
      osType: info.osName.slice(0, 50),
    },
  });

  await writeAudit({
    ctx,
    category: "data",
    action: "server.auto_discover",
    entity: "server",
    entityId: String(serverId),
    after: {
      cpu: `${info.cpuCores} Cores - ${info.cpuModel}`,
      ram: info.ramFormatted,
      gpuCount: info.gpuCount,
      osType: info.osName,
    },
  });

  return info;
}
