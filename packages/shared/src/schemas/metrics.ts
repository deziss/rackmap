import { z } from "zod";

export const ProcInfo = z.object({
  pid: z.number().int(),
  comm: z.string(),
  cpu: z.number(),
  mem: z.number(),
});
export type ProcInfo = z.infer<typeof ProcInfo>;

export const GpuInfo = z.object({
  index: z.number().int(),
  name: z.string(),
  utilPct: z.number(),
  memUsedMb: z.number(),
  memTotalMb: z.number(),
  tempC: z.number().nullable(),
});
export type GpuInfo = z.infer<typeof GpuInfo>;

export const GpuProc = z.object({
  pid: z.number().int(),
  name: z.string(),
  memMb: z.number(),
});
export type GpuProc = z.infer<typeof GpuProc>;

export const DiskInfo = z.object({
  mount: z.string(),
  usedBytes: z.number(),
  totalBytes: z.number(),
  pct: z.number(),
});
export type DiskInfo = z.infer<typeof DiskInfo>;

export const NetInfo = z.object({
  iface: z.string(),
  rxBytesPerSec: z.number(),
  txBytesPerSec: z.number(),
});
export type NetInfo = z.infer<typeof NetInfo>;

export const ServerMetricsDto = z.object({
  reachable: z.literal(true),
  cpu: z.object({
    loadAvg1: z.number(),
    loadAvg5: z.number(),
    loadAvg15: z.number(),
    cores: z.number().int(),
  }),
  mem: z.object({
    usedMb: z.number(),
    totalMb: z.number(),
  }),
  topCpu: z.array(ProcInfo),
  topMem: z.array(ProcInfo),
  disks: z.array(DiskInfo),
  net: z.array(NetInfo),
  gpus: z.array(GpuInfo),
  gpuProcs: z.array(GpuProc),
  hasGpu: z.boolean(),
  collectedAt: z.string(),
});
export type ServerMetricsDto = z.infer<typeof ServerMetricsDto>;

/** Returned (with a non-2xx-style envelope or 503) when the host can't be reached. */
export const ServerMetricsUnreachable = z.object({
  reachable: z.literal(false),
  message: z.string(),
});
export type ServerMetricsUnreachable = z.infer<typeof ServerMetricsUnreachable>;
