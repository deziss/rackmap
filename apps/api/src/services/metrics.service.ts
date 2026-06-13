import type { ServerMetricsDto, ProcInfo, GpuInfo, GpuProc, DiskInfo, NetInfo } from "@inv/shared";
import { env } from "../env.js";
import { connectToServer, SshError } from "./ssh.service.js";

// One combined command, section-delimited, to minimize round-trips.
// Network is sampled twice ~1s apart so we can report bytes/sec server-side.
const METRICS_CMD = [
  'echo "===CPU==="', "cat /proc/loadavg", "nproc",
  'echo "===MEM==="', "free -m | awk 'NR==2{print $3, $2}'",
  'echo "===TOPCPU==="', "ps -eo pid,comm,pcpu,pmem --sort=-pcpu | head -n 11 | tail -n +2",
  'echo "===TOPMEM==="', "ps -eo pid,comm,pcpu,pmem --sort=-pmem | head -n 11 | tail -n +2",
  'echo "===DISK==="', "df -P -B1 | tail -n +2",
  'echo "===NET1==="', "cat /proc/net/dev | tail -n +3",
  "sleep 1",
  'echo "===NET2==="', "cat /proc/net/dev | tail -n +3",
  'echo "===GPU==="',
  'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || echo "NO_GPU"',
  'echo "===GPUPROC==="',
  'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || echo "NO_GPU"',
  'echo "===END==="',
].join("\n");

const PSEUDO_FS = new Set(["tmpfs", "devtmpfs", "udev", "overlay", "squashfs"]);

function sections(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let current = "";
  for (const line of raw.split("\n")) {
    const m = line.match(/^===([A-Z0-9]+)===$/);
    if (m) { current = m[1]!; out[current] = []; continue; }
    if (current) out[current]!.push(line);
  }
  return out;
}

function parseProcs(lines: string[]): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4) continue;
    const pid = Number(t[0]);
    const mem = Number(t[t.length - 1]);
    const cpu = Number(t[t.length - 2]);
    const comm = t.slice(1, t.length - 2).join(" ");
    if (!Number.isFinite(pid)) continue;
    procs.push({ pid, comm, cpu: Number.isFinite(cpu) ? cpu : 0, mem: Number.isFinite(mem) ? mem : 0 });
  }
  return procs;
}

function parseDisks(lines: string[]): DiskInfo[] {
  const disks: DiskInfo[] = [];
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t.length < 6) continue;
    const fs = t[0]!;
    if (PSEUDO_FS.has(fs)) continue;
    const total = Number(t[1]);
    const used = Number(t[2]);
    const mount = t.slice(5).join(" ");
    if (mount.startsWith("/proc") || mount.startsWith("/sys") || mount.startsWith("/run") || mount.startsWith("/dev")) continue;
    if (!Number.isFinite(total) || total === 0) continue;
    disks.push({ mount, usedBytes: used, totalBytes: total, pct: Math.round((used / total) * 100) });
  }
  return disks;
}

function parseNetSample(lines: string[]): Record<string, { rx: number; tx: number }> {
  const map: Record<string, { rx: number; tx: number }> = {};
  for (const line of lines) {
    const [ifacePart, rest] = line.split(":");
    if (!rest) continue;
    const iface = ifacePart!.trim();
    if (iface === "lo" || !iface) continue;
    const n = rest.trim().split(/\s+/).map(Number);
    // /proc/net/dev: rx bytes = n[0], tx bytes = n[8]
    if (n.length < 9) continue;
    map[iface] = { rx: n[0]!, tx: n[8]! };
  }
  return map;
}

function parseNet(s1: string[], s2: string[]): NetInfo[] {
  const a = parseNetSample(s1);
  const b = parseNetSample(s2);
  const net: NetInfo[] = [];
  for (const iface of Object.keys(b)) {
    const prev = a[iface];
    const cur = b[iface]!;
    if (!prev) continue;
    net.push({
      iface,
      rxBytesPerSec: Math.max(0, cur.rx - prev.rx),
      txBytesPerSec: Math.max(0, cur.tx - prev.tx),
    });
  }
  return net;
}

function parseGpus(lines: string[]): GpuInfo[] {
  if (lines.some((l) => l.trim() === "NO_GPU")) return [];
  const gpus: GpuInfo[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const t = line.split(",").map((x) => x.trim());
    if (t.length < 6) continue;
    const index = Number(t[0]);
    if (!Number.isFinite(index)) continue;
    const tempC = Number(t[5]);
    gpus.push({
      index,
      name: t[1]!,
      utilPct: Number(t[2]) || 0,
      memUsedMb: Number(t[3]) || 0,
      memTotalMb: Number(t[4]) || 0,
      tempC: Number.isFinite(tempC) ? tempC : null,
    });
  }
  return gpus;
}

function parseGpuProcs(lines: string[]): GpuProc[] {
  if (lines.some((l) => l.trim() === "NO_GPU")) return [];
  const procs: GpuProc[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const t = line.split(",").map((x) => x.trim());
    if (t.length < 3) continue;
    const pid = Number(t[0]);
    if (!Number.isFinite(pid)) continue;
    procs.push({ pid, name: t[1]!, memMb: Number(t[2]) || 0 });
  }
  return procs;
}

function parseMetrics(raw: string): Omit<ServerMetricsDto, "collectedAt"> {
  const s = sections(raw);

  const loadParts = (s.CPU?.[0] ?? "").trim().split(/\s+/);
  const cores = Number(s.CPU?.[1]) || 1;

  const memParts = (s.MEM?.[0] ?? "").trim().split(/\s+/);

  const gpus = parseGpus(s.GPU ?? []);

  return {
    reachable: true,
    cpu: {
      loadAvg1: Number(loadParts[0]) || 0,
      loadAvg5: Number(loadParts[1]) || 0,
      loadAvg15: Number(loadParts[2]) || 0,
      cores,
    },
    mem: { usedMb: Number(memParts[0]) || 0, totalMb: Number(memParts[1]) || 0 },
    topCpu: parseProcs(s.TOPCPU ?? []),
    topMem: parseProcs(s.TOPMEM ?? []),
    disks: parseDisks(s.DISK ?? []),
    net: parseNet(s.NET1 ?? [], s.NET2 ?? []),
    gpus,
    gpuProcs: parseGpuProcs(s.GPUPROC ?? []),
    hasGpu: gpus.length > 0,
  };
}

/** SSH into a server, collect resource metrics, parse to a typed DTO. Throws SshError on failure. */
export async function fetchMetrics(serverId: number): Promise<ServerMetricsDto> {
  const { client } = await connectToServer(serverId);

  return new Promise<ServerMetricsDto>((resolve, reject) => {
    let stdout = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.end();
      reject(new SshError("unreachable", "Metrics collection timed out"));
    }, env.METRICS_SSH_TIMEOUT_MS + 2000); // +2s over the in-command sleep

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      fn();
    };

    client.exec(METRICS_CMD, (err, stream) => {
      if (err) { finish(() => reject(new SshError("unreachable", err.message))); return; }
      stream
        .on("data", (d: Buffer) => { stdout += d.toString("utf8"); })
        .on("close", () => {
          finish(() => {
            try {
              resolve({ ...parseMetrics(stdout), collectedAt: new Date().toISOString() });
            } catch (e) {
              reject(new SshError("unreachable", `Failed to parse metrics: ${(e as Error).message}`));
            }
          });
        });
      stream.stderr.on("data", () => { /* ignore stderr noise (e.g. nvidia-smi absent) */ });
    });
  });
}
