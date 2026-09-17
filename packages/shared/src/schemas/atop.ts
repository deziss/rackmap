import { z } from "zod";

export const AtopProcess = z.object({
  pid: z.number(),
  name: z.string(),
  cpuPct: z.number().default(0),
  memPct: z.number().default(0),
  memSize: z.string().default("0B"),
  sysCpu: z.string().default("0s"),
  usrCpu: z.string().default("0s"),
  readDsk: z.string().default("0B"),
  writeDsk: z.string().default("0B"),
  dskPct: z.number().default(0),
  netRate: z.string().default("0 sockets"),
  value: z.string().default(""),
});
export type AtopProcess = z.infer<typeof AtopProcess>;

export const AtopTopProcesses = z.object({
  cpu: z.array(AtopProcess),
  mem: z.array(AtopProcess),
  dsk: z.array(AtopProcess),
  net: z.array(AtopProcess),
});
export type AtopTopProcesses = z.infer<typeof AtopTopProcesses>;

export const AtopIntervalSnapshot = z.object({
  timestamp: z.number(),
  dateTime: z.string(),
  elapsedSeconds: z.number(),
  cpu: z.object({
    sysPct: z.number(),
    userPct: z.number(),
    waitPct: z.number(),
    idlePct: z.number(),
    totalPct: z.number(),
    runqueue: z.number(),
  }),
  mem: z.object({
    totalMb: z.number(),
    freeMb: z.number(),
    cacheMb: z.number(),
    slabMb: z.number(),
    usedPct: z.number(),
    swapUsedPct: z.number(),
  }),
  dsk: z.object({
    busyPct: z.number(),
    readSectors: z.number(),
    writeSectors: z.number(),
    device: z.string(),
  }),
  net: z.object({
    inKbps: z.number(),
    outKbps: z.number(),
    interface: z.string(),
  }),
  spikes: z.object({
    isCpuSpike: z.boolean(),
    isMemSpike: z.boolean(),
    isDskSpike: z.boolean(),
    isNetSpike: z.boolean(),
  }),
  topProcesses: z.array(AtopProcess).optional(),
});
export type AtopIntervalSnapshot = z.infer<typeof AtopIntervalSnapshot>;

export const AtopQueryInput = z.object({
  date: z.string().trim().optional(),
  timeFrom: z.string().trim().optional(),
  timeTo: z.string().trim().optional(),
  metricFilter: z.enum(["all", "cpu", "mem", "dsk", "net"]).default("all"),
  cpuThreshold: z.coerce.number().optional().default(70),
  memThreshold: z.coerce.number().optional().default(80),
  dskThreshold: z.coerce.number().optional().default(60),
});
export type AtopQueryInput = z.infer<typeof AtopQueryInput>;

export const AtopTopProcessesInput = z.object({
  date: z.string().trim(),
  time: z.string().trim().optional(),
});
export type AtopTopProcessesInput = z.infer<typeof AtopTopProcessesInput>;

export const AtopTopProcessesResponse = z.object({
  date: z.string(),
  time: z.string().nullable().optional(),
  topProcesses: AtopTopProcesses,
});
export type AtopTopProcessesResponse = z.infer<typeof AtopTopProcessesResponse>;

export const AtopDatesResponse = z.object({
  dates: z.array(z.string()),
  installed: z.boolean(),
  serviceRunning: z.boolean(),
});
export type AtopDatesResponse = z.infer<typeof AtopDatesResponse>;

export const AtopSnapshotsResponse = z.object({
  installed: z.boolean(),
  date: z.string(),
  snapshots: z.array(AtopIntervalSnapshot),
  total: z.number(),
  spikesCount: z.number(),
  topProcesses: AtopTopProcesses.optional(),
});
export type AtopSnapshotsResponse = z.infer<typeof AtopSnapshotsResponse>;
