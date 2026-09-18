import { connectToServer, buildSudoCommand, SshError } from "./ssh.service.js";
import type {
  AtopQueryInput,
  AtopDatesResponse,
  AtopSnapshotsResponse,
  AtopIntervalSnapshot,
  AtopProcess,
  AtopTopProcesses,
} from "@inv/shared";

function formatTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export async function getAtopDates(serverId: number, overridePassword?: string): Promise<AtopDatesResponse> {
  const { client, password } = await connectToServer(serverId, overridePassword);
  const sudoLs = buildSudoCommand("ls -1 /var/log/atop/atop_*", password);

  const script = `
which atop 2>/dev/null || echo "NOT_INSTALLED"
systemctl is-active atop 2>/dev/null || echo "inactive"
ls -1 /var/log/atop/atop_* 2>/dev/null || ${sudoLs} 2>/dev/null || echo ""
`;

  return new Promise((resolve, reject) => {
    let stdout = "";
    client.exec(script, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to inspect atop: ${err.message}`));
      }

      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      stream.on("close", () => {
        client.end();
        const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        const installed = !stdout.includes("NOT_INSTALLED");
        const serviceRunning = lines.some((l) => l === "active");

        const dates: string[] = [];
        for (const line of lines) {
          const match = line.match(/atop_(\d{8})$/);
          if (match && match[1]) {
            dates.push(match[1]);
          }
        }

        // Sort descending (newest first)
        dates.sort((a, b) => b.localeCompare(a));

        resolve({
          dates,
          installed,
          serviceRunning,
        });
      });
    });
  });
}

export function parseTopProcesses(raw: string): AtopTopProcesses {
  function parseSection(tag: "CPU" | "MEM" | "DSK"): AtopProcess[] {
    const marker = `<<<${tag}>>>`;
    if (!raw.includes(marker)) return [];
    const chunk = raw.split(marker)[1]?.split("<<<")[0] || "";
    const lines = chunk.trim().split("\n");
    const hdrIdx = lines.findIndex((l) => l.includes("PID") && (l.includes("CMD") || l.includes("COMMAND")));
    if (hdrIdx === -1) return [];

    const list: AtopProcess[] = [];
    for (let i = hdrIdx + 1; i < lines.length; i++) {
      const parts = lines[i]!.trim().split(/\s+/);
      if (!parts || !/^\d+$/.test(parts[0] || "")) continue;
      const pid = parseInt(parts[0]!, 10);
      const name = parts[parts.length - 1] || "unknown";

      let pctVal = 0;
      for (let j = parts.length - 2; j >= 0; j--) {
        if (parts[j]!.includes("%")) {
          pctVal = parseFloat(parts[j]!.replace("%", "")) || 0;
          break;
        }
      }

      const item: AtopProcess = {
        pid,
        name,
        cpuPct: 0,
        memPct: 0,
        memSize: "0B",
        sysCpu: "0s",
        usrCpu: "0s",
        readDsk: "0B",
        writeDsk: "0B",
        dskPct: 0,
        netRate: "0 sockets",
        value: "",
      };

      if (tag === "CPU") {
        item.cpuPct = pctVal;
        item.sysCpu = parts[1] || "0s";
        item.usrCpu = parts[2] || "0s";
        item.value = `${pctVal.toFixed(1)}% CPU`;
      } else if (tag === "MEM") {
        item.memPct = pctVal;
        item.memSize = parts[3] || "0B";
        item.value = `${item.memSize} (${pctVal.toFixed(0)}%)`;
      } else if (tag === "DSK") {
        item.dskPct = pctVal;
        item.readDsk = parts[2] || "0B";
        item.writeDsk = parts[3] || "0B";
        item.value = `R:${item.readDsk} · W:${item.writeDsk}`;
      }

      list.push(item);
      if (list.length >= 5) break;
    }
    return list;
  }

  const net: AtopProcess[] = [];
  if (raw.includes("<<<SOCKETS>>>")) {
    const chunk = raw.split("<<<SOCKETS>>>")[1]?.split("<<<")[0] || "";
    const seen: Record<number, { pid: number; name: string; count: number }> = {};
    for (const line of chunk.split("\n")) {
      const match = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
      if (match && match[1] && match[2]) {
        const name = match[1];
        const pid = parseInt(match[2], 10);
        if (!seen[pid]) seen[pid] = { pid, name, count: 0 };
        seen[pid]!.count++;
      }
    }
    const sorted = Object.values(seen).sort((a, b) => b.count - a.count);
    for (const sn of sorted.slice(0, 5)) {
      net.push({
        pid: sn.pid,
        name: sn.name,
        cpuPct: 0,
        memPct: 0,
        memSize: "0B",
        sysCpu: "0s",
        usrCpu: "0s",
        readDsk: "0B",
        writeDsk: "0B",
        dskPct: 0,
        netRate: `${sn.count} sockets`,
        value: `${sn.count} Active Sockets`,
      });
    }
  }

  return {
    cpu: parseSection("CPU"),
    mem: parseSection("MEM"),
    dsk: parseSection("DSK"),
    net,
  };
}

export function parseAtopRawOutput(
  raw: string,
  cpuThreshold = 70,
  memThreshold = 80,
  dskThreshold = 60
): AtopIntervalSnapshot[] {
  const intervals = raw.split(/^SEP$/m);
  const snapshots: AtopIntervalSnapshot[] = [];

  for (const interval of intervals) {
    const lines = interval.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let timestamp = 0;
    let dateTime = "";
    let elapsedSeconds = 600;

    let cpu = { sysPct: 0, userPct: 0, waitPct: 0, idlePct: 100, totalPct: 0, runqueue: 0 };
    let mem = { totalMb: 0, freeMb: 0, cacheMb: 0, slabMb: 0, usedPct: 0, swapUsedPct: 0 };
    let dsk = { busyPct: 0, readSectors: 0, writeSectors: 0, device: "none" };
    let net = { inKbps: 0, outKbps: 0, interface: "none" };

    for (const line of lines) {
      const parts = line.split(/\s+/);
      const type = parts[0];

      if (type === "CPU" && parts.length >= 10) {
        timestamp = parseInt(parts[2] || "0", 10);
        dateTime = `${parts[3] || ""} ${parts[4] || ""}`.trim();
        elapsedSeconds = parseInt(parts[5] || "600", 10);
        const ncpu = parseInt(parts[7] || "1", 10);
        const sysTicks = parseInt(parts[8] || "0", 10);
        const userTicks = parseInt(parts[9] || "0", 10);
        const idleTicks = parseInt(parts[11] || "0", 10);
        const waitTicks = parseInt(parts[12] || "0", 10);

        const totalTicks = sysTicks + userTicks + idleTicks + waitTicks;
        if (totalTicks > 0) {
          cpu.sysPct = Math.round((sysTicks / totalTicks) * 100);
          cpu.userPct = Math.round((userTicks / totalTicks) * 100);
          cpu.waitPct = Math.round((waitTicks / totalTicks) * 100);
          cpu.idlePct = Math.max(0, 100 - (cpu.sysPct + cpu.userPct + cpu.waitPct));
          cpu.totalPct = Math.min(100, cpu.sysPct + cpu.userPct + cpu.waitPct);
        }
        cpu.runqueue = ncpu;
      } else if (type === "MEM" && parts.length >= 10) {
        const pageSize = parseInt(parts[6] || "4096", 10);
        const totalPages = parseInt(parts[7] || "0", 10);
        const freePages = parseInt(parts[8] || "0", 10);
        const cachePages = parseInt(parts[9] || "0", 10);
        const slabPages = parseInt(parts[11] || "0", 10);

        const toMb = (pages: number) => Math.round((pages * pageSize) / (1024 * 1024));
        mem.totalMb = toMb(totalPages);
        mem.freeMb = toMb(freePages);
        mem.cacheMb = toMb(cachePages);
        mem.slabMb = toMb(slabPages);

        const usedMb = mem.totalMb - (mem.freeMb + mem.cacheMb);
        mem.usedPct = mem.totalMb > 0 ? Math.max(0, Math.min(100, Math.round((usedMb / mem.totalMb) * 100))) : 0;
      } else if (type === "DSK" && parts.length >= 10) {
        const dev = parts[6] || "disk";
        if (dev !== "loop" && !dev.startsWith("loop")) {
          const busy = parseFloat(parts[parts.length - 1] || "0");
          if (busy >= dsk.busyPct) {
            dsk.device = dev;
            dsk.busyPct = Math.min(100, Math.round(busy));
            dsk.readSectors = parseInt(parts[8] || "0", 10);
            dsk.writeSectors = parseInt(parts[10] || "0", 10);
          }
        }
      } else if (type === "NET" && parts.length >= 10) {
        const iface = parts[6] || "";
        if (iface && iface !== "lo" && iface !== "upper" && !iface.startsWith("veth")) {
          const bytesIn = parseInt(parts[8] || "0", 10);
          const bytesOut = parseInt(parts[10] || "0", 10);
          const inKbps = Math.round((bytesIn * 8) / (elapsedSeconds * 1000));
          const outKbps = Math.round((bytesOut * 8) / (elapsedSeconds * 1000));
          if (inKbps + outKbps >= net.inKbps + net.outKbps) {
            net.interface = iface;
            net.inKbps = inKbps;
            net.outKbps = outKbps;
          }
        }
      }
    }

    if (timestamp > 0) {
      const isCpuSpike = cpu.totalPct >= cpuThreshold;
      const isMemSpike = mem.usedPct >= memThreshold;
      const isDskSpike = dsk.busyPct >= dskThreshold;
      const isNetSpike = net.inKbps + net.outKbps >= 50000;

      snapshots.push({
        timestamp,
        dateTime,
        elapsedSeconds,
        cpu,
        mem,
        dsk,
        net,
        spikes: { isCpuSpike, isMemSpike, isDskSpike, isNetSpike },
      });
    }
  }

  return snapshots.sort((a, b) => b.timestamp - a.timestamp);
}

export async function getAtopSnapshots(serverId: number, query: AtopQueryInput, overridePassword?: string): Promise<AtopSnapshotsResponse> {
  const { client, password } = await connectToServer(serverId, overridePassword);
  const targetDate = query.date ? query.date.replace(/[^0-9]/g, "") : formatTodayDate();
  const filePath = `/var/log/atop/atop_${targetDate}`;

  const timeFlags = [
    query.timeFrom ? `-b ${query.timeFrom}` : "",
    query.timeTo ? `-e ${query.timeTo}` : "",
  ].filter(Boolean).join(" ");

  const atopCmd = `atop -r ${filePath} -P CPU,MEM,DSK,NET ${timeFlags}`;
  const sudoAtop = buildSudoCommand(atopCmd, password);

  // Script with robust file check, interval snapshots, AND top 5 processes by default for that day
  const command = `
if [ ! -f "${filePath}" ]; then
  if ! sudo -n test -f "${filePath}" 2>/dev/null; then
    echo "FILE_NOT_FOUND"
    exit 0
  fi
fi
${atopCmd} 2>/dev/null || ${sudoAtop} 2>/dev/null
echo '<<<TOP_PROCS>>>'
echo '<<<CPU>>>'
atop -r ${filePath} -s 1 1 2>/dev/null | head -n 60 || sudo -n atop -r ${filePath} -s 1 1 2>/dev/null | head -n 60
echo '<<<MEM>>>'
atop -r ${filePath} -m 1 1 2>/dev/null | head -n 60 || sudo -n atop -r ${filePath} -m 1 1 2>/dev/null | head -n 60
echo '<<<DSK>>>'
atop -r ${filePath} -d 1 1 2>/dev/null | head -n 60 || sudo -n atop -r ${filePath} -d 1 1 2>/dev/null | head -n 60
echo '<<<SOCKETS>>>'
ss -tp 2>/dev/null | head -n 60
`;

  return new Promise((resolve, reject) => {
    let stdout = "";
    client.exec(command, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to query atop log: ${err.message}`));
      }

      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      stream.on("close", () => {
        client.end();
        if (stdout.includes("FILE_NOT_FOUND")) {
          return resolve({
            installed: true,
            date: targetDate,
            snapshots: [],
            total: 0,
            spikesCount: 0,
          });
        }

        const [snapshotsPart, topProcsPart] = stdout.split("<<<TOP_PROCS>>>");
        const allSnapshots = parseAtopRawOutput(
          snapshotsPart || "",
          query.cpuThreshold || 70,
          query.memThreshold || 80,
          query.dskThreshold || 60
        );

        let filtered = allSnapshots;
        if (query.metricFilter === "cpu") {
          filtered = allSnapshots.filter((s) => s.spikes.isCpuSpike);
        } else if (query.metricFilter === "mem") {
          filtered = allSnapshots.filter((s) => s.spikes.isMemSpike);
        } else if (query.metricFilter === "dsk") {
          filtered = allSnapshots.filter((s) => s.spikes.isDskSpike);
        } else if (query.metricFilter === "net") {
          filtered = allSnapshots.filter((s) => s.spikes.isNetSpike);
        }

        const spikesCount = allSnapshots.filter(
          (s) => s.spikes.isCpuSpike || s.spikes.isMemSpike || s.spikes.isDskSpike || s.spikes.isNetSpike
        ).length;

        const topProcesses = topProcsPart ? parseTopProcesses(topProcsPart) : undefined;

        resolve({
          installed: true,
          date: targetDate,
          snapshots: filtered,
          total: filtered.length,
          spikesCount,
          topProcesses,
        });
      });
    });
  });
}

export async function getAtopTopProcesses(
  serverId: number,
  date: string,
  time?: string,
  overridePassword?: string
): Promise<AtopTopProcesses> {
  const { client, password } = await connectToServer(serverId, overridePassword);
  const targetDate = date.replace(/[^0-9]/g, "");
  const filePath = `/var/log/atop/atop_${targetDate}`;
  const timeFlag = time ? `-b ${time}` : "";

  const command = `
if [ ! -f "${filePath}" ]; then
  if ! sudo -n test -f "${filePath}" 2>/dev/null; then
    echo "FILE_NOT_FOUND"
    exit 0
  fi
fi
echo '<<<CPU>>>'
atop -r ${filePath} ${timeFlag} -s 1 1 2>/dev/null | head -n 60 || sudo -n atop -r ${filePath} ${timeFlag} -s 1 1 2>/dev/null | head -n 60
echo '<<<MEM>>>'
atop -r ${filePath} ${timeFlag} -m 1 1 2>/dev/null | head -n 60 || sudo -n atop -r ${filePath} ${timeFlag} -m 1 1 2>/dev/null | head -n 60
echo '<<<DSK>>>'
atop -r ${filePath} ${timeFlag} -d 1 1 2>/dev/null | head -n 60 || sudo -n atop -r ${filePath} ${timeFlag} -d 1 1 2>/dev/null | head -n 60
echo '<<<SOCKETS>>>'
ss -tp 2>/dev/null | head -n 60
`;

  return new Promise((resolve, reject) => {
    let stdout = "";
    client.exec(command, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to query top processes: ${err.message}`));
      }

      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      stream.on("close", () => {
        client.end();
        if (stdout.includes("FILE_NOT_FOUND")) {
          return resolve({ cpu: [], mem: [], dsk: [], net: [] });
        }
        resolve(parseTopProcesses(stdout));
      });
    });
  });
}

export async function getAtopIntervalProcesses(
  serverId: number,
  date: string,
  time: string,
  overridePassword?: string
): Promise<AtopProcess[]> {
  const { client } = await connectToServer(serverId, overridePassword);
  const targetDate = date.replace(/[^0-9]/g, "");
  const filePath = `/var/log/atop/atop_${targetDate}`;

  // Use atop -r -b <time> -e <time> to get human-readable top processes
  const command = `atop -r ${filePath} -b ${time} -e ${time} 2>/dev/null | sed -n '30,60p'`;

  return new Promise((resolve) => {
    let stdout = "";
    client.exec(command, (err, stream) => {
      if (err) {
        client.end();
        return resolve([]);
      }

      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      stream.on("close", () => {
        client.end();
        const processes: AtopProcess[] = [];
        const lines = stdout.split("\n").filter((l) => l.trim().length > 0);

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 9 && /^\d+$/.test(parts[0]!)) {
            const pid = parseInt(parts[0]!, 10);
            const sysCpu = parts[1] || "0s";
            const usrCpu = parts[2] || "0s";
            const readDsk = parts[5] || "0B";
            const writeDsk = parts[6] || "0B";
            const cpuPct = parseFloat((parts[7] || "0%").replace("%", "")) || 0;
            const name = parts.slice(8).join(" ") || "unknown";

            processes.push({
              pid,
              name,
              cpuPct,
              memPct: 0,
              memSize: "0B",
              sysCpu,
              usrCpu,
              readDsk,
              writeDsk,
              dskPct: 0,
              netRate: "0 sockets",
              value: `${cpuPct}%`,
            });
          }
        }

        resolve(processes.slice(0, 15));
      });
    });
  });
}
