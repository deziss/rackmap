import { createHash } from "node:crypto";
import {
  DRIFT_CATEGORIES,
  DRIFT_CATEGORY_LABELS,
  DRIFT_SEVERITY_RANK,
  type DriftAuthorizedKey,
  type DriftCategory,
  type DriftChangeItem,
  type DriftChanges,
  type DriftSeverity,
  type DriftSnapshotData,
  type DriftUser,
} from "@inv/shared";
import { PRIVILEGED_OS_GROUPS } from "./os-user.service.js";

/**
 * Pure half of drift detection: canonical hashing of a snapshot and the
 * snapshot-vs-baseline comparison with its severity rules. No I/O here, so
 * every rule is unit-testable without a host or a database.
 *
 * Severity rules
 *   critical  new uid-0 account (or an account changed to uid 0), new sudoers
 *             rule, new privileged-group member, new authorized key for root or
 *             for any privileged user
 *   warning   new account, other account changes, new listening port, a port
 *             now served by a different process, a crontab added or changed,
 *             new authorized key for an unprivileged user
 *   info      unit enabled/disabled, port closed, account/key/rule/member removed
 *
 * A category that either side could not collect (`null`) is skipped and
 * reported as such; it is never read as "everything was removed".
 */

const PRIVILEGED_GROUP_SET = new Set<string>(PRIVILEGED_OS_GROUPS);

/** Cap per change list stored on a DriftEvent; the rest is counted in `omitted`. */
export const MAX_ITEMS_PER_LIST = 200;

// ---------------------------------------------------------------------------
// Canonical JSON + hash
// ---------------------------------------------------------------------------

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

/** JSON with object keys sorted at every level (array order is kept: arrays are sorted at collection). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The snapshot hash covers the collected content only: not `ranAsRoot`,
 * `warnings` or the reasons in `unavailable`, which describe how the scan went
 * rather than what the host looks like.
 */
export function snapshotHash(data: DriftSnapshotData): string {
  return sha256Hex(
    canonicalJson({
      v: data.v,
      users: data.users,
      groups: data.groups,
      sudoers: data.sudoers,
      crontabs: data.crontabs,
      ports: data.ports,
      units: data.units,
      authorizedKeys: data.authorizedKeys,
    }),
  );
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

export function maxSeverity(severities: Iterable<DriftSeverity>): DriftSeverity {
  let best: DriftSeverity = "info";
  for (const s of severities) if (DRIFT_SEVERITY_RANK[s] > DRIFT_SEVERITY_RANK[best]) best = s;
  return best;
}

export function changesSeverity(changes: DriftChanges): DriftSeverity {
  return maxSeverity([...changes.added, ...changes.removed, ...changes.changed].map((i) => i.severity));
}

export function changeCount(changes: DriftChanges): number {
  return changes.added.length + changes.removed.length + changes.changed.length + (changes.omitted ?? 0);
}

// ---------------------------------------------------------------------------
// sudoers subjects (who a rule grants rights to)
// ---------------------------------------------------------------------------

export interface SudoersSubjects {
  users: Set<string>;
  groups: Set<string>;
  /** A rule for `ALL` users exists: everyone is privileged. */
  everyone: boolean;
}

/**
 * Users and `%groups` that sudoers rules name. Over-approximates on purpose
 * (every User_Alias member counts, whether or not the alias is used), since the
 * result only ever raises a severity.
 */
export function sudoersSubjects(rules: readonly string[]): SudoersSubjects {
  const out: SudoersSubjects = { users: new Set(), groups: new Set(), everyone: false };
  const addSubject = (raw: string) => {
    const s = raw.trim();
    if (!s || s.startsWith("!") || s.startsWith("+") || s.startsWith("#")) return;
    if (s === "ALL") {
      out.everyone = true;
      return;
    }
    if (s.startsWith("%")) {
      const g = s.replace(/^%:?/, "");
      if (g && !g.startsWith("#")) out.groups.add(g);
      return;
    }
    out.users.add(s);
  };
  for (const rule of rules) {
    if (/^[#@]include/.test(rule)) continue;
    if (/^User_Alias\s/.test(rule)) {
      // User_Alias A = alice, %ops : B = bob
      for (const part of rule.replace(/^User_Alias\s+/, "").split(":")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        for (const m of part.slice(eq + 1).split(",")) addSubject(m);
      }
      continue;
    }
    if (/^(?:Cmnd|Host|Runas|Cmd)_Alias\s/.test(rule)) continue;
    const first = rule.split(/\s+/)[0] ?? "";
    for (const s of first.split(",")) addSubject(s);
  }
  return out;
}

/** Accounts that are root-equivalent in `data`: uid 0, a privileged/sudoers group member, or a sudoers subject. */
export function privilegedUsers(data: DriftSnapshotData): { names: Set<string>; everyone: boolean } {
  const names = new Set<string>(["root"]);
  for (const u of data.users ?? []) if (u.uid === 0) names.add(u.name);
  // Every group in the snapshot is there because it is privileged or sudoers grants it rights.
  for (const g of Object.values(data.groups ?? {})) for (const m of g.members) names.add(m);
  let everyone = false;
  if (data.sudoers) {
    const subj = sudoersSubjects(data.sudoers);
    for (const u of subj.users) names.add(u);
    everyone = subj.everyone;
  }
  return { names, everyone };
}

// ---------------------------------------------------------------------------
// Per-category diffs
// ---------------------------------------------------------------------------

const emptyChanges = (): DriftChanges => ({ added: [], removed: [], changed: [] });

function byKey<T>(items: readonly T[], key: (t: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) m.set(key(it), it);
  return m;
}

function describeUser(u: DriftUser): string {
  return `uid ${u.uid}, gid ${u.gid}, home ${u.home || "—"}, shell ${u.shell || "—"}`;
}

function diffUsers(before: DriftUser[], after: DriftUser[]): DriftChanges {
  const out = emptyChanges();
  const a = byKey(before, (u) => u.name);
  const b = byKey(after, (u) => u.name);
  for (const [name, u] of b) {
    const old = a.get(name);
    if (!old) {
      const root = u.uid === 0;
      out.added.push({
        key: name,
        label: root ? `New uid-0 account ${name} (${describeUser(u)})` : `New account ${name} (${describeUser(u)})`,
        severity: root ? "critical" : "warning",
        after: u,
      });
      continue;
    }
    const diffs: string[] = [];
    for (const f of ["uid", "gid", "home", "shell"] as const) {
      if (old[f] !== u[f]) diffs.push(`${f} ${old[f] === "" ? "—" : old[f]} → ${u[f] === "" ? "—" : u[f]}`);
    }
    if (diffs.length > 0) {
      const becameRoot = u.uid === 0 && old.uid !== 0;
      out.changed.push({
        key: name,
        label: becameRoot ? `Account ${name} is now uid 0 (${diffs.join(", ")})` : `Account ${name}: ${diffs.join(", ")}`,
        severity: becameRoot ? "critical" : "warning",
        before: old,
        after: u,
      });
    }
  }
  for (const [name, u] of a) {
    if (!b.has(name)) out.removed.push({ key: name, label: `Account ${name} removed`, severity: "info", before: u });
  }
  return out;
}

function diffGroups(before: DriftSnapshotData, after: DriftSnapshotData): DriftChanges {
  const out = emptyChanges();
  const a = before.groups ?? {};
  const b = after.groups ?? {};
  // A non-privileged group is only in a snapshot because sudoers names it. When
  // that side could not read sudoers, its absence means "unknown", not "gone".
  const comparable = (group: string, side: DriftSnapshotData) => PRIVILEGED_GROUP_SET.has(group) || side.sudoers !== null;
  for (const group of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const ga = a[group];
    const gb = b[group];
    if (!ga && !comparable(group, before)) continue;
    if (!gb && !comparable(group, after)) continue;
    const ma = new Set(ga?.members ?? []);
    const mb = new Set(gb?.members ?? []);
    for (const m of mb) {
      if (!ma.has(m)) {
        out.added.push({ key: `${group}:${m}`, label: `${m} added to privileged group ${group}`, severity: "critical", after: { group, member: m } });
      }
    }
    for (const m of ma) {
      if (!mb.has(m)) {
        out.removed.push({ key: `${group}:${m}`, label: `${m} removed from group ${group}`, severity: "info", before: { group, member: m } });
      }
    }
  }
  return out;
}

function diffStringSet(
  before: readonly string[],
  after: readonly string[],
  added: (s: string) => Pick<DriftChangeItem, "label" | "severity">,
  removed: (s: string) => Pick<DriftChangeItem, "label" | "severity">,
): DriftChanges {
  const out = emptyChanges();
  const a = new Set(before);
  const b = new Set(after);
  for (const s of b) if (!a.has(s)) out.added.push({ key: s, ...added(s) });
  for (const s of a) if (!b.has(s)) out.removed.push({ key: s, ...removed(s) });
  return out;
}

export function crontabTargetLabel(target: string): string {
  if (target === "system") return "/etc/crontab";
  if (target.startsWith("user:")) return `crontab of ${target.slice(5)}`;
  if (target.startsWith("crond:")) return `/etc/cron.d/${target.slice(6)}`;
  return target;
}

function diffCrontabs(before: Record<string, string>, after: Record<string, string>): DriftChanges {
  const out = emptyChanges();
  for (const [t, h] of Object.entries(after)) {
    const old = before[t];
    if (old === undefined) {
      out.added.push({ key: t, label: `New ${crontabTargetLabel(t)}`, severity: "warning", after: h });
    } else if (old !== h) {
      out.changed.push({ key: t, label: `${crontabTargetLabel(t)} changed`, severity: "warning", before: old, after: h });
    }
  }
  for (const [t, h] of Object.entries(before)) {
    if (!(t in after)) out.removed.push({ key: t, label: `${crontabTargetLabel(t)} removed`, severity: "info", before: h });
  }
  return out;
}

function diffPorts(before: NonNullable<DriftSnapshotData["ports"]>, after: NonNullable<DriftSnapshotData["ports"]>): DriftChanges {
  const out = emptyChanges();
  const key = (p: { proto: string; local: string }) => `${p.proto} ${p.local}`;
  const a = byKey(before, key);
  const b = byKey(after, key);
  for (const [k, p] of b) {
    const old = a.get(k);
    if (!old) {
      out.added.push({ key: k, label: `New listening port ${k}${p.process ? ` (${p.process})` : ""}`, severity: "warning", after: p });
    } else if (old.process !== null && p.process !== null && old.process !== p.process) {
      // Only when both sides could see process names (a non-root scan cannot).
      out.changed.push({ key: k, label: `${k} is now served by ${p.process} (was ${old.process})`, severity: "warning", before: old, after: p });
    }
  }
  for (const [k, p] of a) {
    if (!b.has(k)) out.removed.push({ key: k, label: `Port ${k} closed${p.process ? ` (${p.process})` : ""}`, severity: "info", before: p });
  }
  return out;
}

function keyLabel(k: DriftAuthorizedKey): string {
  return [k.type, k.fp, k.comment].filter(Boolean).join(" ");
}

function diffAuthorizedKeys(before: DriftSnapshotData, after: DriftSnapshotData): DriftChanges {
  const out = emptyChanges();
  const a = before.authorizedKeys ?? {};
  const b = after.authorizedKeys ?? {};
  // Judge privilege on the newest account data available.
  const ref: DriftSnapshotData = {
    ...after,
    users: after.users ?? before.users,
    groups: after.groups ?? before.groups,
    sudoers: after.sudoers ?? before.sudoers,
  };
  const priv = privilegedUsers(ref);
  for (const user of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const ka = byKey(a[user] ?? [], (k) => k.fp);
    const kb = byKey(b[user] ?? [], (k) => k.fp);
    const privileged = priv.everyone || priv.names.has(user);
    for (const [fp, k] of kb) {
      if (ka.has(fp)) continue;
      out.added.push({
        key: `${user} ${fp}`,
        label: `New authorized key for ${user}${privileged ? " (privileged)" : ""}: ${keyLabel(k)}`,
        severity: privileged ? "critical" : "warning",
        after: { user, ...k },
      });
    }
    for (const [fp, k] of ka) {
      if (!kb.has(fp)) {
        out.removed.push({ key: `${user} ${fp}`, label: `Authorized key removed from ${user}: ${keyLabel(k)}`, severity: "info", before: { user, ...k } });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot vs baseline
// ---------------------------------------------------------------------------

export interface CategoryDiff {
  severity: DriftSeverity;
  changes: DriftChanges;
  summary: string;
  /** sha256 of the full (untruncated) change set; equal fingerprints = the same drift. */
  fingerprint: string;
}

export interface DriftDiffResult {
  /** Only categories with at least one change. */
  categories: Partial<Record<DriftCategory, CategoryDiff>>;
  /** Categories not compared, with the reason. */
  skipped: Partial<Record<DriftCategory, string>>;
}

const DATA_KEY: Record<DriftCategory, keyof DriftSnapshotData> = {
  users: "users",
  groups: "groups",
  sudoers: "sudoers",
  crontabs: "crontabs",
  ports: "ports",
  units: "units",
  authorized_keys: "authorizedKeys",
};

function sortItems(items: DriftChangeItem[]): DriftChangeItem[] {
  return items.sort(
    (x, y) => DRIFT_SEVERITY_RANK[y.severity] - DRIFT_SEVERITY_RANK[x.severity] || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );
}

/** "2 added, 1 changed" */
function countsText(c: DriftChanges): string {
  const parts: string[] = [];
  if (c.added.length) parts.push(`${c.added.length} added`);
  if (c.removed.length) parts.push(`${c.removed.length} removed`);
  if (c.changed.length) parts.push(`${c.changed.length} changed`);
  return parts.join(", ");
}

export function summarizeChanges(category: DriftCategory, changes: DriftChanges): string {
  const all = [...changes.added, ...changes.changed, ...changes.removed];
  const ordered = sortItems([...all]);
  const shown = ordered.slice(0, 2).map((i) => i.label);
  const more = all.length - shown.length;
  const text = `${DRIFT_CATEGORY_LABELS[category]}: ${countsText(changes)} — ${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

function truncate(changes: DriftChanges): DriftChanges {
  let omitted = 0;
  const cap = (list: DriftChangeItem[]) => {
    if (list.length <= MAX_ITEMS_PER_LIST) return list;
    omitted += list.length - MAX_ITEMS_PER_LIST;
    return list.slice(0, MAX_ITEMS_PER_LIST);
  };
  const out: DriftChanges = { added: cap(changes.added), removed: cap(changes.removed), changed: cap(changes.changed) };
  if (omitted > 0) out.omitted = omitted;
  return out;
}

export function diffSnapshots(baseline: DriftSnapshotData, current: DriftSnapshotData): DriftDiffResult {
  const result: DriftDiffResult = { categories: {}, skipped: {} };
  for (const category of DRIFT_CATEGORIES) {
    const k = DATA_KEY[category];
    if (baseline[k] === null || baseline[k] === undefined) {
      result.skipped[category] = `not collected in the baseline${baseline.unavailable?.[category] ? ` (${baseline.unavailable[category]})` : ""}`;
      continue;
    }
    if (current[k] === null || current[k] === undefined) {
      result.skipped[category] = `not collected in this scan${current.unavailable?.[category] ? ` (${current.unavailable[category]})` : ""}`;
      continue;
    }
    let changes: DriftChanges;
    switch (category) {
      case "users":
        changes = diffUsers(baseline.users!, current.users!);
        break;
      case "groups":
        changes = diffGroups(baseline, current);
        break;
      case "sudoers":
        changes = diffStringSet(
          baseline.sudoers!,
          current.sudoers!,
          (r) => ({ label: `New sudoers rule: ${r}`, severity: "critical" }),
          (r) => ({ label: `sudoers rule removed: ${r}`, severity: "info" }),
        );
        break;
      case "crontabs":
        changes = diffCrontabs(baseline.crontabs!, current.crontabs!);
        break;
      case "ports":
        changes = diffPorts(baseline.ports!, current.ports!);
        break;
      case "units":
        changes = diffStringSet(
          baseline.units!,
          current.units!,
          (u) => ({ label: `Unit ${u} enabled`, severity: "info" }),
          (u) => ({ label: `Unit ${u} disabled`, severity: "info" }),
        );
        break;
      case "authorized_keys":
        changes = diffAuthorizedKeys(baseline, current);
        break;
    }
    if (changes.added.length + changes.removed.length + changes.changed.length === 0) continue;
    sortItems(changes.added);
    sortItems(changes.removed);
    sortItems(changes.changed);
    result.categories[category] = {
      severity: changesSeverity(changes),
      summary: summarizeChanges(category, changes),
      fingerprint: sha256Hex(canonicalJson(changes)),
      changes: truncate(changes),
    };
  }
  return result;
}
