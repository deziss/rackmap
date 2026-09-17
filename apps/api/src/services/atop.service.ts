import { connectToServer, buildSudoCommand, SshError } from "./ssh.service.js";
import type {
  AtopQueryInput,
  AtopDatesResponse,
  AtopSnapshotsResponse,
  AtopIntervalSnapshot,
  AtopProcess,
} from "@inv/shared";

function formatTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export async function getAtopDates(serverId: number): Promise<AtopDatesResponse> {
  const { client, password } = await connectToServer(serverId);
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
        // CPU hostname epoch yyyy/mm/dd hh:mm:ss elapsed ticks_per_sec ncpu sys user irq idle wait ...
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
        // MEM hostname epoch date time elapsed pagesize physmem free cache buff slab ...
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
        // DSK hostname epoch date time elapsed devname reads read_sec writes write_sec ... busy%
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
        // NET hostname epoch date time elapsed devname pcki bytesi pcko byteso ...
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

  // Sort descending by timestamp
  return snapshots.sort((a, b) => b.timestamp - a.timestamp);
}

export async function getAtopSnapshots(serverId: number, query: AtopQueryInput): Promise<AtopSnapshotsResponse> {
  const { client, password } = await connectToServer(serverId);
  const targetDate = query.date ? query.date.replace(/[^0-9]/g, "") : formatTodayDate();
  const filePath = `/var/log/atop/atop_${targetDate}`;

  const timeFlags = [
    query.timeFrom ? `-b ${query.timeFrom}` : "",
    query.timeTo ? `-e ${query.timeTo}` : "",
  ].filter(Boolean).join(" ");

  const atopCmd = `atop -r ${filePath} -P CPU,MEM,DSK,NET ${timeFlags}`;
  const sudoAtop = buildSudoCommand(atopCmd, password);
  const testFile = buildSudoCommand(`test -f ${filePath}`, password);

  const command = `
if [ ! -f ${filePath} ] && ! ${testFile}; then
  echo "FILE_NOT_FOUND"
  exit 0
fi
${atopCmd} 2>/dev/null || ${sudoAtop} 2>/dev/null
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

        const allSnapshots = parseAtopRawOutput(
          stdout,
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

        resolve({
          installed: true,
          date: targetDate,
          snapshots: filtered,
          total: filtered.length,
          spikesCount,
        });
      });
    });
  });
}

export async function getAtopIntervalProcesses(
  serverId: number,
  date: string,
  time: string
): Promise<AtopProcess[]> {
  const { client } = await connectToServer(serverId);
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
          // Look for line starting with numeric PID
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
              sysCpu,
              usrCpu,
              readDsk,
              writeDsk,
            });
          }
        }

        resolve(processes.slice(0, 15));
      });
    });
  });
}
