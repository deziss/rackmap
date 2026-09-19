import { z } from "zod";

export const HardwareDiskInfo = z.object({
  name: z.string(),
  size: z.string(),
  type: z.string(),
  model: z.string(),
});
export type HardwareDiskInfo = z.infer<typeof HardwareDiskInfo>;

export const ServerHardwareInfo = z.object({
  cpuModel: z.string(),
  cpuCores: z.number(),
  cpuThreads: z.number(),
  ramBytes: z.number(),
  ramFormatted: z.string(),
  osName: z.string(),
  kernel: z.string(),
  arch: z.string(),
  hostname: z.string(),
  gpuCount: z.number(),
  gpuModel: z.string().nullable(),
  disks: z.array(HardwareDiskInfo),
  totalStorage: z.string().optional(),
  totalStorageBytes: z.number().optional(),
  uptime: z.string(),
});
export type ServerHardwareInfo = z.infer<typeof ServerHardwareInfo>;
