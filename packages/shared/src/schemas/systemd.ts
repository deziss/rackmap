import { z } from "zod";

/**
 * systemd service manager (per-server "Services" tab).
 *
 * A unit name ends up in a root shell on the managed host, so the format is
 * pinned conservatively here AND re-checked by the API at the point of
 * interpolation (where it is additionally passed through escapeShellArg).
 */

export const SYSTEMD_UNIT_TYPES = ["service", "timer", "socket", "target", "path", "mount"] as const;
export type SystemdUnitType = (typeof SYSTEMD_UNIT_TYPES)[number];

/** No backslash, quote, space, "/" or "$": systemd's \x2d escapes are not accepted (such units are listed but not actionable). */
export const SYSTEMD_UNIT_NAME_PATTERN = /^[A-Za-z0-9@._:-]{1,200}\.(service|timer|socket|target|path|mount)$/;

/**
 * True for a unit name RackMap will act on. Besides the pattern, a leading "-"
 * is refused (it would read as an option to systemctl/journalctl) except for
 * the root mount "-.mount".
 */
export function isValidSystemdUnitName(name: string): boolean {
  if (!SYSTEMD_UNIT_NAME_PATTERN.test(name)) return false;
  if (name.startsWith("-") && name !== "-.mount") return false;
  return true;
}

export const SystemdUnitName = z
  .string()
  .max(210)
  .refine(isValidSystemdUnitName, "Invalid systemd unit name (letters, digits, @ . _ : - and a .service/.timer/.socket/.target/.path/.mount suffix)");

/** `type` filter of GET /servers/:id/systemd/units. */
export const SYSTEMD_LIST_TYPES = ["service", "timer", "socket", "all"] as const;
export type SystemdListType = (typeof SYSTEMD_LIST_TYPES)[number];

export const SystemdListQuery = z.object({
  type: z.enum(SYSTEMD_LIST_TYPES).default("service"),
  /** Case-insensitive substring of the unit name or description; filtered in the API, never sent to the host. */
  q: z.string().max(200).optional(),
});
export type SystemdListQuery = z.infer<typeof SystemdListQuery>;

export const SYSTEMD_ACTIONS = ["start", "stop", "restart", "reload", "enable", "disable"] as const;
export type SystemdAction = (typeof SYSTEMD_ACTIONS)[number];

export const SystemdActionInput = z.object({ action: z.enum(SYSTEMD_ACTIONS) });
export type SystemdActionInput = z.infer<typeof SystemdActionInput>;

export const SYSTEMD_LOG_LINES_MAX = 2000;

/** "1h", "30m", "15min", "2d", "1w", "90s" — relative to now on the host. */
const SINCE_RELATIVE = /^(\d{1,5})(s|m|min|h|d|w)$/;
/** "2026-09-25", "2026-09-25T10:00", "2026-09-25 10:00:00", optionally with Z / ±hh:mm. */
const SINCE_ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function isValidJournalSince(value: string): boolean {
  if (SINCE_RELATIVE.test(value)) return true;
  if (!SINCE_ISO.test(value)) return false;
  return !Number.isNaN(Date.parse(value.replace(" ", "T")));
}

/**
 * The `--since=` argument journalctl gets for a validated `since` (or null when
 * invalid). Relative spans become "-<n><unit>"; an ISO time without a zone is
 * passed as host-local "YYYY-MM-DD HH:MM:SS"; one with a zone becomes "@<epoch>".
 */
export function journalSinceArg(value: string): string | null {
  const rel = SINCE_RELATIVE.exec(value);
  if (rel) {
    const unit = rel[2] === "m" ? "min" : rel[2]!;
    return `-${Number(rel[1])}${unit}`;
  }
  if (!isValidJournalSince(value)) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && value.length > 10;
  if (hasZone) return `@${Math.floor(Date.parse(value.replace(" ", "T")) / 1000)}`;
  const [date, time] = value.replace("T", " ").split(" ");
  const hms = time ? time.split(".")[0]! : "00:00:00";
  return `${date} ${hms.length === 5 ? `${hms}:00` : hms}`;
}

export const SystemdLogsQuery = z.object({
  lines: z.coerce.number().int().min(1).max(SYSTEMD_LOG_LINES_MAX).default(200),
  since: z
    .string()
    .max(40)
    .refine(isValidJournalSince, 'Invalid "since": use an ISO date/time or a relative span like "1h"')
    .optional(),
});
export type SystemdLogsQuery = z.infer<typeof SystemdLogsQuery>;

// ---------------------------------------------------------------------------
// Protected units
// ---------------------------------------------------------------------------

/**
 * Units whose stop / restart / disable can cut the host off (SSH, networking,
 * D-Bus, the container runtime, …). Matched on the name without its suffix and,
 * for templates, on the part before "@" (so ssh.socket and sshd@….service count).
 */
export const SYSTEMD_PROTECTED_NAMES = [
  "ssh",
  "sshd",
  "dbus",
  "dbus-broker",
  "networking",
  "network",
  "NetworkManager",
  "systemd-networkd",
  "systemd-resolved",
  "cron",
  "crond",
  "docker",
  "containerd",
  "kubelet",
  "getty",
  "serial-getty",
] as const;

/**
 * Units where ANY action needs server:sudo: starting them reboots, powers off,
 * suspends or drops the host to rescue mode (or opens an unauthenticated root
 * shell, debug-shell). Every .target unit counts too: `start reboot.target` is a reboot.
 */
export const SYSTEMD_CRITICAL_NAMES = [
  "systemd-reboot",
  "systemd-poweroff",
  "systemd-halt",
  "systemd-kexec",
  "systemd-soft-reboot",
  "systemd-suspend",
  "systemd-hibernate",
  "systemd-hybrid-sleep",
  "systemd-suspend-then-hibernate",
  "rescue",
  "emergency",
  "debug-shell",
] as const;

/** Actions that interrupt a protected unit. */
export const SYSTEMD_DISRUPTIVE_ACTIONS: readonly SystemdAction[] = ["stop", "restart", "disable"];

function splitUnit(unit: string): { base: string; template: string | null; type: string } {
  const dot = unit.lastIndexOf(".");
  const base = dot > 0 ? unit.slice(0, dot) : unit;
  const type = dot > 0 ? unit.slice(dot + 1) : "";
  const at = base.indexOf("@");
  return { base, template: at >= 0 ? base.slice(0, at) : null, type };
}

/** ssh/sshd/dbus/networking/cron/docker/getty@*, every systemd-*, every .target and .mount. */
export function isProtectedSystemdUnit(unit: string): boolean {
  const { base, template, type } = splitUnit(unit);
  if (type === "target" || type === "mount") return true;
  if (base.startsWith("systemd-")) return true;
  const names: readonly string[] = SYSTEMD_PROTECTED_NAMES;
  return names.includes(base) || (template !== null && names.includes(template));
}

export function isCriticalSystemdUnit(unit: string): boolean {
  const { base, template, type } = splitUnit(unit);
  if (type === "target") return true;
  const names: readonly string[] = SYSTEMD_CRITICAL_NAMES;
  return names.includes(base) || (template !== null && names.includes(template));
}

/** The one rule: does `action` on `unit` require server:sudo on top of server:systemd? */
export function systemdActionNeedsSudo(unit: string, action: SystemdAction): boolean {
  if (isCriticalSystemdUnit(unit)) return true;
  return isProtectedSystemdUnit(unit) && SYSTEMD_DISRUPTIVE_ACTIONS.includes(action);
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface SystemdUnitDto {
  unit: string;
  /** LOAD column: loaded / not-found / masked / error / bad-setting, or "not-loaded" for a unit file systemd has not loaded. */
  load: string;
  /** ACTIVE column: active / inactive / failed / activating / deactivating / reloading. */
  active: string;
  /** SUB column: running / exited / dead / listening / waiting / mounted / … */
  sub: string;
  description: string;
  /** UnitFileState from list-unit-files: enabled / disabled / static / masked / indirect / generated / … (null when unknown). */
  enabled: string | null;
}

export interface SystemdUnitListResponse {
  /** False when the host does not run systemd (no systemctl or /run/systemd/system). */
  supported: boolean;
  units: SystemdUnitDto[];
  /** More units than the API returns (capped). */
  truncated?: boolean;
  /** The read ran without root (sudo unavailable); journals may be incomplete. */
  ranAsRoot?: boolean;
}

export interface SystemdUnitDetails {
  unit: string;
  id: string;
  description: string;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string | null;
  mainPid: number | null;
  /** ExecMainStartTimestamp as printed by systemctl, e.g. "Fri 2026-09-25 10:00:00 UTC". */
  startedAt: string | null;
  memoryBytes: number | null;
  fragmentPath: string | null;
  restart: string | null;
  nRestarts: number | null;
  /** Last 20 journal lines (short-iso). */
  journal: string[];
  ranAsRoot: boolean;
}

export interface SystemdLogsResponse {
  unit: string;
  lines: string[];
  truncated: boolean;
  ranAsRoot: boolean;
}

export interface SystemdActionResponse {
  unit: string;
  action: SystemdAction;
  /** systemctl exited 0. */
  ok: boolean;
  exitCode: number | null;
  activeState: string | null;
  subState: string | null;
  unitFileState: string | null;
  stderr: string;
}
