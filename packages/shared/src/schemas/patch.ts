import { z } from "zod";
import { CursorQuery } from "./common.js";

/**
 * Fleet patch management: pending package updates, security updates and
 * reboot-required state per server (one `server_patch_status` row each), plus
 * the "apply updates" action. Nothing here ever reboots a host.
 */

export const PATCH_PACKAGE_MANAGERS = ["apt", "dnf", "yum", "zypper", "unknown"] as const;
export type PatchPackageManager = (typeof PATCH_PACKAGE_MANAGERS)[number];

/** Outcome of the last scan. "unsupported" = no apt/dnf/yum/zypper on the host. */
export const PATCH_SCAN_STATUSES = ["ok", "error", "unsupported"] as const;
export type PatchScanStatus = (typeof PATCH_SCAN_STATUSES)[number];

/** Rows kept per server for display; the counts always cover every pending update. */
export const PATCH_PACKAGES_MAX = 300;

export const PatchPackage = z.object({
  name: z.string(),
  /** Installed version; null when the package manager does not report it. */
  current: z.string().nullable(),
  available: z.string(),
  security: z.boolean(),
});
export type PatchPackage = z.infer<typeof PatchPackage>;

export const ServerPatchStatusDto = z.object({
  serverId: z.number().int(),
  packageManager: z.enum(PATCH_PACKAGE_MANAGERS).nullable(),
  upgradableCount: z.number().int(),
  securityCount: z.number().int(),
  rebootRequired: z.boolean(),
  kernelRunning: z.string().nullable(),
  kernelLatest: z.string().nullable(),
  /** A newer kernel than the running one is installed (a reboot activates it). */
  kernelUpdatePending: z.boolean(),
  osPretty: z.string().nullable(),
  /** Security updates first, capped at PATCH_PACKAGES_MAX. */
  packages: z.array(PatchPackage),
  /** True when `packages` holds fewer rows than `upgradableCount`. */
  packagesTruncated: z.boolean(),
  status: z.enum(PATCH_SCAN_STATUSES),
  /**
   * With status "error": why the scan failed (the counts are those of the last
   * good scan). With status "ok": a warning, e.g. stale package lists.
   */
  error: z.string().nullable(),
  scannedAt: z.string(),
  lastAppliedAt: z.string().nullable(),
});
export type ServerPatchStatusDto = z.infer<typeof ServerPatchStatusDto>;

/** POST /servers/:id/patches/scan — refresh the package index first (default true; needs root). */
export const PatchScanInput = z.object({
  refresh: z.boolean().optional(),
});
export type PatchScanInput = z.infer<typeof PatchScanInput>;

export const PATCH_APPLY_MODES = ["security", "all"] as const;
export type PatchApplyMode = (typeof PATCH_APPLY_MODES)[number];

/** POST /servers/:id/patches/apply */
export const PatchApplyInput = z.object({
  mode: z.enum(PATCH_APPLY_MODES),
});
export type PatchApplyInput = z.infer<typeof PatchApplyInput>;

export const PatchApplyResponse = z.object({
  ok: z.boolean(),
  mode: z.enum(PATCH_APPLY_MODES),
  packageManager: z.enum(PATCH_PACKAGE_MANAGERS),
  /** The command that ran on the host, for display. */
  command: z.string(),
  exitCode: z.number().int().nullable(),
  /** Combined stdout+stderr of the package manager (the tail when capped). */
  output: z.string(),
  outputTruncated: z.boolean(),
  durationMs: z.number().int(),
  /** Status after the post-apply rescan; null when the rescan failed. */
  status: ServerPatchStatusDto.nullable(),
  rescanError: z.string().nullable(),
});
export type PatchApplyResponse = z.infer<typeof PatchApplyResponse>;

/** POST /patches/scan — all non-deleted servers when serverIds is omitted. */
export const PatchFleetScanInput = z.object({
  serverIds: z.array(z.number().int().positive()).min(1).max(5000).optional(),
});
export type PatchFleetScanInput = z.infer<typeof PatchFleetScanInput>;

export const PatchFleetScanResponse = z.object({
  /** Scans newly queued (servers already queued or scanning are skipped). */
  queued: z.number().int(),
});
export type PatchFleetScanResponse = z.infer<typeof PatchFleetScanResponse>;

const queryBool = z.preprocess((v) => v === "true" || v === true, z.boolean());

export const PATCH_LIST_SORT_KEYS = [
  "hostname",
  "environment",
  "securityCount",
  "upgradableCount",
  "rebootRequired",
  "status",
  "packageManager",
  "scannedAt",
] as const;
export type PatchListSortKey = (typeof PATCH_LIST_SORT_KEYS)[number];

/** GET /patches — `status: "never"` lists servers that were never scanned. */
export const PatchListQuery = CursorQuery.extend({
  q: z.string().trim().max(255).optional(),
  securityOnly: queryBool.optional(),
  rebootRequired: queryBool.optional(),
  status: z.enum(["ok", "error", "unsupported", "never"] as const).optional(),
  sortBy: z.enum(PATCH_LIST_SORT_KEYS).optional(),
});
export type PatchListQuery = z.infer<typeof PatchListQuery>;

export const PatchFleetRow = z.object({
  serverId: z.number().int(),
  hostname: z.string(),
  ip: z.string(),
  environment: z.string().nullable(),
  location: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  /** Reachability from the status probe ("up" | "down" | "unknown"). */
  lastStatus: z.string(),
  /** Null until the server has been scanned once. `packages` is omitted in the list. */
  patch: ServerPatchStatusDto.omit({ packages: true }).nullable(),
});
export type PatchFleetRow = z.infer<typeof PatchFleetRow>;

export const PatchListResponse = z.object({
  items: z.array(PatchFleetRow),
  nextCursor: z.number().int().nullable(),
  total: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
});
export type PatchListResponse = z.infer<typeof PatchListResponse>;

export const PatchSummary = z.object({
  /** Non-deleted servers. */
  totalServers: z.number().int(),
  scanned: z.number().int(),
  neverScanned: z.number().int(),
  /** Servers with at least one pending security update. */
  withSecurityUpdates: z.number().int(),
  /** Servers with at least one pending update. */
  withUpdates: z.number().int(),
  totalUpdates: z.number().int(),
  totalSecurityUpdates: z.number().int(),
  rebootRequired: z.number().int(),
  errors: z.number().int(),
  unsupported: z.number().int(),
  lastScannedAt: z.string().nullable(),
  /** Scans queued or running on the API instance that answered (not fleet-wide). */
  scanning: z.number().int(),
});
export type PatchSummary = z.infer<typeof PatchSummary>;
