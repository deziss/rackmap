import { z } from "zod";

/**
 * Configuration drift detection.
 *
 * A scan takes one snapshot of a host's security-relevant configuration (accounts,
 * privileged group members, sudoers rules, crontab hashes, listening sockets,
 * enabled systemd units, authorized SSH keys) and compares it with the server's
 * baseline. Every category with differences becomes one DriftEvent. The first
 * snapshot of a server becomes its baseline; afterwards only an explicit
 * "accept as baseline" moves it.
 */

export const DRIFT_CATEGORIES = ["users", "groups", "sudoers", "crontabs", "ports", "units", "authorized_keys"] as const;
export const DriftCategory = z.enum(DRIFT_CATEGORIES);
export type DriftCategory = z.infer<typeof DriftCategory>;

export const DRIFT_CATEGORY_LABELS: Record<DriftCategory, string> = {
  users: "User accounts",
  groups: "Privileged group members",
  sudoers: "sudoers rules",
  crontabs: "Crontabs",
  ports: "Listening ports",
  units: "Enabled systemd units",
  authorized_keys: "Authorized SSH keys",
};

export const DRIFT_SEVERITIES = ["info", "warning", "critical"] as const;
export const DriftSeverity = z.enum(DRIFT_SEVERITIES);
export type DriftSeverity = z.infer<typeof DriftSeverity>;

export const DRIFT_SEVERITY_RANK: Record<DriftSeverity, number> = { info: 0, warning: 1, critical: 2 };

// ---------------------------------------------------------------------------
// Snapshot content (ServerSnapshot.data)
// ---------------------------------------------------------------------------

export interface DriftUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export interface DriftGroup {
  gid: number;
  /** Explicit members plus users whose primary gid is this group, sorted. */
  members: string[];
}

export interface DriftPort {
  proto: string;
  /** `addr:port`; ports in the ephemeral range (>= 32768) are collapsed to `addr:ephemeral`. */
  local: string;
  /** Sorted, comma-joined process names (pids stripped); null when not visible (non-root scan). */
  process: string | null;
}

export interface DriftAuthorizedKey {
  /** `SHA256:<base64>` exactly as `ssh-keygen -lf` prints it, or `LINE:<sha256 hex>` for an unparseable line. */
  fp: string;
  type: string;
  comment: string;
}

/**
 * One snapshot. A category is `null` when it could not be collected (typically
 * because sudo was unavailable); the diff never reads null as "everything removed".
 */
export interface DriftSnapshotData {
  v: 1;
  ranAsRoot: boolean;
  users: DriftUser[] | null;
  /** Privileged groups plus groups that sudoers grants rights to via `%group`. */
  groups: Record<string, DriftGroup> | null;
  /** Normalized rules (comments, blank lines and Defaults stripped), sorted and de-duplicated. */
  sudoers: string[] | null;
  /** Target (`user:<name>`, `system`, `crond:<file>`) -> sha256 hex of the file. */
  crontabs: Record<string, string> | null;
  ports: DriftPort[] | null;
  /** Enabled unit file names, sorted. */
  units: string[] | null;
  /** User -> keys sorted by fingerprint. */
  authorizedKeys: Record<string, DriftAuthorizedKey[]> | null;
  /** Category -> why it is null. */
  unavailable: Partial<Record<DriftCategory, string>>;
  /** Non-fatal collection notes (skipped files with unusual names, truncation). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Changes (DriftEvent.changes)
// ---------------------------------------------------------------------------

export interface DriftChangeItem {
  /** Stable identity within the category, e.g. `alice`, `tcp 0.0.0.0:22`, `root SHA256:…`. */
  key: string;
  /** One human-readable line. */
  label: string;
  severity: DriftSeverity;
  before?: unknown;
  after?: unknown;
}

export interface DriftChanges {
  added: DriftChangeItem[];
  removed: DriftChangeItem[];
  changed: DriftChangeItem[];
  /** Items left out of the lists above (each list is capped); counted, not shown. */
  omitted?: number;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const DriftEventsQuery = z.object({
  status: z.enum(["open", "all"]).default("open"),
  serverId: z.coerce.number().int().positive().optional(),
  severity: DriftSeverity.optional(),
  category: DriftCategory.optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type DriftEventsQuery = z.infer<typeof DriftEventsQuery>;

export interface DriftEventDto {
  id: number;
  serverId: number;
  server: { id: number; hostname: string } | null;
  category: DriftCategory;
  severity: DriftSeverity;
  summary: string;
  changes: DriftChanges;
  snapshotId: number | null;
  detectedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string; name: string; email: string } | null;
}

export interface DriftEventListResponse {
  items: DriftEventDto[];
  nextCursor: number | null;
}

export interface DriftSeverityCounts {
  critical: number;
  warning: number;
  info: number;
  total: number;
}

export interface DriftSummaryResponse {
  open: DriftSeverityCounts;
  servers: Array<{
    serverId: number;
    hostname: string;
    open: number;
    maxSeverity: DriftSeverity;
    lastDetectedAt: string;
  }>;
}

export interface DriftSnapshotSummary {
  id: number;
  takenAt: string;
  hash: string;
  isBaseline: boolean;
  ranAsRoot: boolean;
  /** Items per category; null for a category that could not be collected. */
  counts: Record<DriftCategory, number | null>;
  unavailable: Partial<Record<DriftCategory, string>>;
  warnings: string[];
}

export interface ServerDriftResponse {
  serverId: number;
  baseline: DriftSnapshotSummary | null;
  latest: DriftSnapshotSummary | null;
  /** True when the latest snapshot's hash equals the baseline's. */
  matchesBaseline: boolean | null;
  openCounts: DriftSeverityCounts;
  openEvents: DriftEventDto[];
}

export interface DriftScanResponse {
  snapshot: DriftSnapshotSummary;
  /** The server had no baseline, so this snapshot became it (no events). */
  baselineCreated: boolean;
  /** Events created by this scan (drift already reported by the previous scan is not repeated). */
  events: DriftEventDto[];
  /** Categories that differ from the baseline, whether new or already reported. */
  driftedCategories: DriftCategory[];
}

export interface DriftBaselineResponse {
  baseline: DriftSnapshotSummary;
  acknowledged: number;
}

export interface DriftAcknowledgeResponse {
  event: DriftEventDto;
}
