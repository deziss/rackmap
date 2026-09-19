import { z } from "zod";

export const LogSourceEnum = z.enum(["journalctl", "auth", "syslog", "dmesg"]);
export type LogSource = z.infer<typeof LogSourceEnum>;

export const LogPriorityEnum = z.enum(["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"]);
export type LogPriority = z.infer<typeof LogPriorityEnum>;

export const LogQueryInput = z.object({
  source: LogSourceEnum.default("journalctl"),
  unit: z.string().trim().optional(),
  priority: LogPriorityEnum.optional(),
  since: z.string().trim().optional(),
  lines: z.coerce.number().int().min(1).max(2000).default(200),
  filterText: z.string().trim().optional(),
});
export type LogQueryInput = z.infer<typeof LogQueryInput>;

export const LogEntry = z.object({
  timestamp: z.string().nullable(),
  service: z.string().nullable(),
  priority: z.string().nullable(),
  message: z.string(),
  raw: z.string(),
});
export type LogEntry = z.infer<typeof LogEntry>;

export const LogResponse = z.object({
  entries: z.array(LogEntry),
  total: z.number(),
  source: z.string(),
  totalLogSize: z.string().nullable().optional(),
  journalDiskUsage: z.string().nullable().optional(),
});
export type LogResponse = z.infer<typeof LogResponse>;
