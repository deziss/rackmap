/**
 * CONTRACT (Wave 0) — crontab parsing shared by the API and the web app.
 * Owned by the cron agent, who implements the bodies; the types and function
 * signatures are relied on by the heartbeats agent and must stay stable.
 *
 * Kinds: "user" = `crontab -l -u <user>` format (5 time fields + command);
 *        "system" = /etc/crontab and /etc/cron.d (5 time fields + user + command).
 *
 * Conventions:
 *  - A disabled entry is the entry text prefixed with `#rackmap:disabled `.
 *  - A label is a comment line directly above an entry: `# rackmap: <label>`;
 *    a monitored entry's label line is `# rackmap: <label> hb=<heartbeatId>`.
 *
 * Runs in node and in the browser: no node: imports here.
 */
import { Cron } from "croner";
import { CRON_USERNAME_PATTERN } from "./schemas/cron.js";

export type CronKind = "user" | "system";

export type CronLine =
  | {
      type: "entry";
      lineNo: number;
      raw: string;
      /** 5-field expression or @nickname (e.g. "@daily", "@reboot"). */
      schedule: string;
      /** Only for kind "system". */
      user?: string;
      /** Everything after the schedule (and user), verbatim, including any `%` stdin part. */
      command: string;
      disabled: boolean;
      /** From a `# rackmap: <label>` comment directly above, if any. */
      label?: string;
      /** From a `# rackmap: … hb=<id>` label line, if any. */
      heartbeatId?: number;
    }
  | { type: "env"; lineNo: number; raw: string; name: string; value: string }
  | { type: "comment" | "blank"; lineNo: number; raw: string }
  | { type: "invalid"; lineNo: number; raw: string; error: string };

export type CronEntryLine = Extract<CronLine, { type: "entry" }>;

export type CronScheduleCheck = { ok: true } | { ok: false; error: string };

/** Prefix that turns an entry into a comment cron ignores, while RackMap still shows it. */
export const CRON_DISABLED_PREFIX = "#rackmap:disabled ";
/** Prefix of the label comment line directly above an entry. */
export const CRON_LABEL_PREFIX = "# rackmap:";
/**
 * vixie/Debian cron refuses or truncates commands past MAX_COMMAND (1000);
 * keep a margin so the limit is never hit on the host.
 */
export const CRON_MAX_LINE_LENGTH = 990;

/** The @nicknames vixie cron and cronie both accept, with their 5-field meaning (null = @reboot). */
export const CRON_NICKNAMES: Readonly<Record<string, string | null>> = {
  "@reboot": null,
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

// ---------------------------------------------------------------------------
// Schedule validation
// ---------------------------------------------------------------------------

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  /** Three-letter names, index + nameBase = value. */
  names?: readonly string[];
  nameBase?: number;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  {
    name: "month",
    min: 1,
    max: 12,
    names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
    nameBase: 1,
  },
  // 7 is Sunday as well, as in vixie cron.
  { name: "day of week", min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], nameBase: 0 },
];

/**
 * One comma-separated item of a field: `*`, `N`, `N-M`, `* /S` or `N-M/S`, where N/M
 * may be a three-letter name. Deliberately excludes everything croner accepts but
 * vixie/cronie do not (`L`, `W`, `#`, `?`, `N/S`), because /etc/cron.d gets no
 * syntax check on install and cron would silently skip the line.
 */
const ITEM_PATTERN = /^(?:(\*)|([0-9]{1,2}|[a-z]{3})(?:-([0-9]{1,2}|[a-z]{3}))?)(?:\/([0-9]{1,2}))?$/i;

function fieldValue(token: string, spec: FieldSpec): number | string {
  if (/^[0-9]+$/.test(token)) {
    const n = Number(token);
    if (n < spec.min || n > spec.max) return `${spec.name} value ${token} is outside ${spec.min}-${spec.max}`;
    return n;
  }
  const idx = spec.names?.indexOf(token.toLowerCase()) ?? -1;
  if (idx < 0) return `"${token}" is not a valid ${spec.name}`;
  return idx + (spec.nameBase ?? 0);
}

function checkField(field: string, spec: FieldSpec): string | null {
  for (const item of field.split(",")) {
    const m = ITEM_PATTERN.exec(item);
    if (!m) {
      if (/[LW#?]/i.test(item)) return `"${item}" uses L/W/#/? syntax, which cron does not support (${spec.name})`;
      return `"${item}" is not a valid ${spec.name}`;
    }
    const [, star, lo, hi, step] = m;
    if (step !== undefined) {
      if (!star && hi === undefined) return `"${item}": a step needs "*" or a range, e.g. */${step} (${spec.name})`;
      const s = Number(step);
      if (s < 1 || s > spec.max) return `"${item}": step must be between 1 and ${spec.max} (${spec.name})`;
    }
    if (star) continue;
    const a = fieldValue(lo!, spec);
    if (typeof a === "string") return a;
    if (hi !== undefined) {
      const b = fieldValue(hi, spec);
      if (typeof b === "string") return b;
      if (a > b) return `"${item}": range start is after its end (${spec.name})`;
    }
  }
  return null;
}

/** Map a nickname to its 5-field form; @reboot → null; anything else is returned trimmed. */
export function expandCronNickname(schedule: string): string | null {
  const s = schedule.trim();
  if (s in CRON_NICKNAMES) return CRON_NICKNAMES[s] ?? null;
  return s;
}

const CRONER_OPTIONS = { mode: "5-part", domAndDow: false, paused: true } as const;

/** Vixie/cronie-compatible validation (rejects croner-only syntax such as L, W, #, ?). */
export function validateCronSchedule(schedule: string): CronScheduleCheck {
  const s = schedule.trim();
  if (!s) return { ok: false, error: "Schedule is empty" };
  if (s.startsWith("@")) {
    return s in CRON_NICKNAMES
      ? { ok: true }
      : { ok: false, error: `Unknown schedule nickname "${s}" (use ${Object.keys(CRON_NICKNAMES).join(", ")})` };
  }
  const fields = s.split(/\s+/);
  if (fields.length !== 5) {
    const hint = fields.length > 5 ? " — seconds and year fields are not supported by cron" : "";
    return {
      ok: false,
      error: `Expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}${hint}`,
    };
  }
  for (let i = 0; i < 5; i++) {
    const err = checkField(fields[i]!, FIELD_SPECS[i]!);
    if (err) return { ok: false, error: err };
  }
  // The regex pass is the gate; croner is a second opinion (and what computes run times).
  try {
    new Cron(s, CRONER_OPTIONS);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}

/** Next run times for a (validated) schedule; `@reboot` yields []. Invalid input also yields []. */
export function nextCronRuns(schedule: string, opts: { timezone?: string; count?: number; from?: Date } = {}): Date[] {
  if (!validateCronSchedule(schedule).ok) return [];
  const expr = expandCronNickname(schedule);
  if (expr === null) return [];
  try {
    const job = new Cron(expr, { ...CRONER_OPTIONS, ...(opts.timezone ? { timezone: opts.timezone } : {}) });
    return job.nextRuns(opts.count ?? 5, opts.from ?? new Date());
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `NAME=value`, `NAME = value`, `"NAME"=value` — cron tries this before parsing an entry. */
const ENV_PATTERN = /^\s*(?:"([^"]*)"|'([^']*)'|([^\s="']+))\s*=(.*)$/;

function unquoteEnvValue(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

interface Token {
  text: string;
  end: number;
}

function nextToken(s: string, pos: number): Token | null {
  let i = pos;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  if (i >= s.length) return null;
  let j = i;
  while (j < s.length && s[j] !== " " && s[j] !== "\t") j++;
  return { text: s.slice(i, j), end: j };
}

type EntryFields = { schedule: string; user?: string; command: string };

/** Parse the text of an (enabled) entry. */
function parseEntryText(text: string, kind: CronKind): { ok: true; fields: EntryFields } | { ok: false; error: string } {
  const first = nextToken(text, 0);
  if (!first) return { ok: false, error: "Empty line" };
  if (!/^[0-9*@]/.test(first.text)) {
    return { ok: false, error: "Not a cron job, environment setting or comment" };
  }
  let pos: number;
  let schedule: string;
  if (first.text.startsWith("@")) {
    schedule = first.text;
    pos = first.end;
  } else {
    const parts = [first.text];
    pos = first.end;
    while (parts.length < 5) {
      const t = nextToken(text, pos);
      if (!t) return { ok: false, error: "Incomplete schedule: expected 5 time fields and a command" };
      parts.push(t.text);
      pos = t.end;
    }
    schedule = parts.join(" ");
  }
  const check = validateCronSchedule(schedule);
  if (!check.ok) return { ok: false, error: check.error };

  let user: string | undefined;
  if (kind === "system") {
    const u = nextToken(text, pos);
    if (!u) return { ok: false, error: "Missing user field (system crontabs name the user before the command)" };
    if (u.text.length > 32 || !CRON_USERNAME_PATTERN.test(u.text)) return { ok: false, error: `Invalid user "${u.text}"` };
    user = u.text;
    pos = u.end;
  }
  let start = pos;
  while (start < text.length && (text[start] === " " || text[start] === "\t")) start++;
  const command = text.slice(start);
  if (!command.trim()) return { ok: false, error: "Missing command" };
  return { ok: true, fields: user === undefined ? { schedule, command } : { schedule, user, command } };
}

/** Parse a label line (`# rackmap: <label>[ hb=<id>]`); null when the line is not one. */
export function parseCronLabelLine(raw: string): { label?: string; heartbeatId?: number } | null {
  if (!raw.startsWith(CRON_LABEL_PREFIX)) return null;
  const rest = raw.slice(CRON_LABEL_PREFIX.length);
  if (rest !== "" && !rest.startsWith(" ")) return null;
  let text = rest.trim();
  let heartbeatId: number | undefined;
  const hb = /(?:^|\s)hb=([0-9]{1,10})$/.exec(text);
  if (hb) {
    heartbeatId = Number(hb[1]);
    text = text.slice(0, hb.index).trim();
  }
  const out: { label?: string; heartbeatId?: number } = {};
  if (text) out.label = text;
  if (heartbeatId !== undefined) out.heartbeatId = heartbeatId;
  return out;
}

/** Build a label line; any `hb=` text inside `label` is dropped so it cannot forge a link. */
export function formatCronLabelLine(label?: string, heartbeatId?: number): string {
  const clean = (label ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/(?:^|\s)hb=[0-9]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = [clean, heartbeatId !== undefined ? `hb=${heartbeatId}` : ""].filter(Boolean);
  return parts.length ? `${CRON_LABEL_PREFIX} ${parts.join(" ")}` : CRON_LABEL_PREFIX;
}

function parseLine(raw: string, lineNo: number, kind: CronKind): CronLine {
  if (raw.trim() === "") return { type: "blank", lineNo, raw };
  if (raw.startsWith(CRON_DISABLED_PREFIX)) {
    const r = parseEntryText(raw.slice(CRON_DISABLED_PREFIX.length), kind);
    // A disabled line that no longer parses is just a comment to everyone.
    if (!r.ok) return { type: "comment", lineNo, raw };
    return { type: "entry", lineNo, raw, ...r.fields, disabled: true };
  }
  if (/^\s*#/.test(raw)) return { type: "comment", lineNo, raw };
  if (raw.endsWith("\r")) {
    return { type: "invalid", lineNo, raw, error: "Windows line ending (CR): cron would pass it into the command" };
  }
  const env = ENV_PATTERN.exec(raw);
  if (env) {
    const name = env[1] ?? env[2] ?? env[3] ?? "";
    return { type: "env", lineNo, raw, name, value: unquoteEnvValue(env[4] ?? "") };
  }
  const r = parseEntryText(raw, kind);
  if (!r.ok) return { type: "invalid", lineNo, raw, error: r.error };
  return { type: "entry", lineNo, raw, ...r.fields, disabled: false };
}

/** Split into lines; a single trailing newline terminates the last line rather than starting a new one. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Parse a crontab; lineNo is 1-based. Never throws — bad lines become `invalid`. */
export function parseCrontab(text: string, kind: CronKind): CronLine[] {
  const out: CronLine[] = [];
  splitLines(text).forEach((raw, i) => {
    const line = parseLine(raw, i + 1, kind);
    const prev = out[out.length - 1];
    if (line.type === "entry" && prev?.type === "comment") {
      const lab = parseCronLabelLine(prev.raw);
      if (lab?.label !== undefined) line.label = lab.label;
      if (lab?.heartbeatId !== undefined) line.heartbeatId = lab.heartbeatId;
    }
    out.push(line);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Build the text of one entry line from its fields (respects `disabled`). */
export function formatCronEntry(
  entry: { schedule: string; user?: string; command: string; disabled?: boolean },
  kind: CronKind,
): string {
  const parts = [entry.schedule.trim()];
  if (kind === "system") parts.push(entry.user ?? "root");
  parts.push(entry.command);
  const text = parts.join(" ");
  return entry.disabled ? CRON_DISABLED_PREFIX + text : text;
}

function formatEnvLine(name: string, value: string): string {
  return value === "" || /^\s|\s$/.test(value) ? `${name}="${value}"` : `${name}=${value}`;
}

/**
 * Inverse of parseCrontab: untouched lines are emitted byte-for-byte from `raw`.
 *
 * An entry (or env line) whose fields no longer match its `raw` is re-rendered
 * from the fields, so callers may edit `schedule`/`command`/`disabled`/`user`
 * directly. Changing an entry's `label`/`heartbeatId` rewrites, inserts or drops
 * the label line directly above it. Every line is newline-terminated (cron needs
 * the final newline), which is the only normalisation of an unmodified file.
 */
export function serializeCrontab(lines: CronLine[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.type === "entry") {
      const kind: CronKind = line.user !== undefined ? "system" : "user";
      const fromRaw = line.raw.startsWith(CRON_DISABLED_PREFIX)
        ? parseEntryText(line.raw.slice(CRON_DISABLED_PREFIX.length), kind)
        : parseEntryText(line.raw, kind);
      const untouched =
        fromRaw.ok &&
        line.raw.startsWith(CRON_DISABLED_PREFIX) === line.disabled &&
        fromRaw.fields.schedule === line.schedule &&
        fromRaw.fields.user === line.user &&
        fromRaw.fields.command === line.command;
      const text = untouched ? line.raw : formatCronEntry(line, kind);

      const prev = lines[i - 1];
      const prevLabel = prev?.type === "comment" ? parseCronLabelLine(prev.raw) : null;
      const wantLabel = line.label !== undefined || line.heartbeatId !== undefined;
      if (prevLabel) {
        if (prevLabel.label !== line.label || prevLabel.heartbeatId !== line.heartbeatId) {
          out.pop();
          if (wantLabel) out.push(formatCronLabelLine(line.label, line.heartbeatId));
        }
      } else if (wantLabel) {
        out.push(formatCronLabelLine(line.label, line.heartbeatId));
      }
      out.push(text);
    } else if (line.type === "env") {
      const env = ENV_PATTERN.exec(line.raw);
      const same =
        env !== null && (env[1] ?? env[2] ?? env[3]) === line.name && unquoteEnvValue(env[4] ?? "") === line.value;
      out.push(same ? line.raw : formatEnvLine(line.name, line.value));
    } else {
      out.push(line.raw);
    }
  }
  return out.map((l) => l + "\n").join("");
}

// ---------------------------------------------------------------------------
// Editing helpers (pure; return a new line array — serialize, then re-parse
// to get fresh line numbers)
// ---------------------------------------------------------------------------

export type CronEntryPatch = Partial<Pick<CronEntryLine, "schedule" | "user" | "command" | "disabled" | "label" | "heartbeatId">>;

function applyPatch(entry: CronEntryLine, patch: CronEntryPatch): CronEntryLine {
  const next: CronEntryLine = { ...entry };
  if (patch.schedule !== undefined) next.schedule = patch.schedule.trim();
  if (patch.command !== undefined) next.command = patch.command;
  if (patch.disabled !== undefined) next.disabled = patch.disabled;
  if ("user" in patch) {
    if (patch.user) next.user = patch.user;
    else delete next.user;
  }
  if ("label" in patch) {
    if (patch.label) next.label = patch.label;
    else delete next.label;
  }
  if ("heartbeatId" in patch) {
    if (patch.heartbeatId !== undefined) next.heartbeatId = patch.heartbeatId;
    else delete next.heartbeatId;
  }
  return next;
}

/** Update the entry on `lineNo`. Optional keys present with `undefined`/"" are cleared (e.g. `{ label: undefined }`). */
export function updateCronEntry(lines: CronLine[], lineNo: number, patch: CronEntryPatch): CronLine[] {
  return lines.map((l) => (l.type === "entry" && l.lineNo === lineNo ? applyPatch(l, patch) : l));
}

/** Add an entry after `afterLineNo` (default: end of file). */
export function insertCronEntry(
  lines: CronLine[],
  entry: { schedule: string; user?: string; command: string; disabled?: boolean; label?: string; heartbeatId?: number },
  afterLineNo?: number,
): CronLine[] {
  const kind: CronKind = entry.user !== undefined ? "system" : "user";
  const line: CronEntryLine = {
    type: "entry",
    lineNo: 0,
    raw: formatCronEntry(entry, kind),
    schedule: entry.schedule.trim(),
    command: entry.command,
    disabled: entry.disabled ?? false,
  };
  if (entry.user !== undefined) line.user = entry.user;
  if (entry.label) line.label = entry.label;
  if (entry.heartbeatId !== undefined) line.heartbeatId = entry.heartbeatId;
  const idx = afterLineNo === undefined ? -1 : lines.findIndex((l) => l.lineNo === afterLineNo);
  if (idx < 0) return [...lines, line];
  return [...lines.slice(0, idx + 1), line, ...lines.slice(idx + 1)];
}

/** Remove the entry on `lineNo` together with its label line. */
export function removeCronEntry(lines: CronLine[], lineNo: number): CronLine[] {
  const idx = lines.findIndex((l) => l.type === "entry" && l.lineNo === lineNo);
  if (idx < 0) return lines;
  const prev = lines[idx - 1];
  const dropLabel = prev?.type === "comment" && parseCronLabelLine(prev.raw) !== null;
  return lines.filter((_, i) => i !== idx && !(dropLabel && i === idx - 1));
}

// ---------------------------------------------------------------------------
// Whole-file checks and helpers
// ---------------------------------------------------------------------------

export interface CronLineProblem {
  lineNo: number;
  error: string;
}

/** Every reason cron would reject or mangle a line: `invalid` lines plus over-long entries/env lines. */
export function validateCrontab(text: string, kind: CronKind): CronLineProblem[] {
  const problems: CronLineProblem[] = [];
  for (const line of parseCrontab(text, kind)) {
    if (line.type === "invalid") problems.push({ lineNo: line.lineNo, error: line.error });
    else if ((line.type === "env" || (line.type === "entry" && !line.disabled)) && line.raw.length > CRON_MAX_LINE_LENGTH) {
      problems.push({
        lineNo: line.lineNo,
        error: `Line is ${line.raw.length} characters; cron truncates or refuses lines over ${CRON_MAX_LINE_LENGTH} — move the command into a script`,
      });
    }
  }
  return problems;
}

/** Environment in effect for the entry on `lineNo` (env lines above it, later ones win). */
export function cronEnvAt(lines: CronLine[], lineNo: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const l of lines) {
    if (l.lineNo >= lineNo) break;
    if (l.type === "env") env[l.name] = l.value;
  }
  return env;
}

/**
 * cron's `%` rule: the first unescaped `%` ends the command and the rest becomes
 * the job's stdin, with each further unescaped `%` turned into a newline; `\%`
 * is a literal `%` in both parts.
 */
export function splitCronCommand(command: string): { command: string; stdin: string | null } {
  let cmd = "";
  let stdin: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\" && command[i + 1] === "%") {
      if (stdin === null) cmd += "%";
      else stdin += "%";
      i++;
      continue;
    }
    if (ch === "%") {
      if (stdin === null) stdin = "";
      else stdin += "\n";
      continue;
    }
    if (stdin === null) cmd += ch;
    else stdin += ch;
  }
  return { command: cmd, stdin: stdin === null ? null : stdin + "\n" };
}

export type CronDiffOp = { op: "same" | "add" | "del"; text: string };

/** Line diff (LCS over the region between the common prefix and suffix). */
export function diffCronLines(before: string, after: string): CronDiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  // lcs[i][j] = LCS length of am[i..] and bm[j..], flattened.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] =
        am[i] === bm[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    }
  }
  const ops: CronDiffOp[] = a.slice(0, pre).map((text) => ({ op: "same" as const, text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      ops.push({ op: "same", text: am[i]! });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i * (m + 1) + j + 1]! >= lcs[(i + 1) * (m + 1) + j]!)) {
      ops.push({ op: "add", text: bm[j]! });
      j++;
    } else {
      ops.push({ op: "del", text: am[i]! });
      i++;
    }
  }
  for (const text of a.slice(a.length - suf)) ops.push({ op: "same", text });
  return ops;
}
