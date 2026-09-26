import { z } from "zod";
import { Cron } from "croner";

/**
 * Runbooks: admin-authored scripts executed across a selected set of servers.
 *
 * Everything here is shared by the API (validation at the boundary) and the web
 * app (form validation and types). The executor-only pieces — the shell prelude
 * and output masking — live in apps/api/src/services/runbook-params.ts.
 */

// ─── Enumerations ────────────────────────────────────────────────────────────

export const RUNBOOK_PARAM_TYPES = ["string", "number", "boolean", "enum", "secret"] as const;
export type RunbookParamType = (typeof RUNBOOK_PARAM_TYPES)[number];

export const RUNBOOK_INTERPRETERS = ["bash", "sh"] as const;
export type RunbookInterpreter = (typeof RUNBOOK_INTERPRETERS)[number];

export const RUNBOOK_RUN_AS = ["sshUser", "root"] as const;
export type RunbookRunAs = (typeof RUNBOOK_RUN_AS)[number];

export const RUNBOOK_RUN_STATUSES = [
  "pending_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "partially_failed",
  "cancelled",
  "rejected",
  "expired",
] as const;
export type RunbookRunStatus = (typeof RUNBOOK_RUN_STATUSES)[number];

/** Statuses a run can still leave on its own; everything else is terminal. */
export const RUNBOOK_ACTIVE_RUN_STATUSES = ["pending_approval", "queued", "running"] as const satisfies readonly RunbookRunStatus[];

export function isRunbookRunActive(status: string): boolean {
  return (RUNBOOK_ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

export const RUNBOOK_HOST_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
] as const;
export type RunbookHostStatus = (typeof RUNBOOK_HOST_STATUSES)[number];

/** Why a host did not succeed. Stored in RunbookHostResult.errorCode. */
export const RUNBOOK_HOST_ERROR_CODES = [
  "VAULT_LOCKED",
  "NO_CREDENTIALS",
  "NOT_FOUND",
  "UNREACHABLE",
  "AUTH_FAILED",
  "HOST_KEY_CHANGED",
  "UPLOAD_FAILED",
  "SUDO_PASSWORD_REQUIRED",
  "SUDO_AUTH_FAILED",
  "SUDO_REQUIRETTY",
  "SUDO_NOT_ALLOWED",
  "NO_INTERPRETER",
  "TIMEOUT",
  "CANCELLED",
  "NONZERO_EXIT",
  "EXEC_FAILED",
  "EXECUTOR_LOST",
] as const;
export type RunbookHostErrorCode = (typeof RUNBOOK_HOST_ERROR_CODES)[number];

/** Bounds shared by the editor form and the API. */
export const RUNBOOK_LIMITS = {
  scriptMaxBytes: 65_536,
  maxParams: 50,
  paramValueMaxLength: 4096,
  paramPatternMaxLength: 200,
  timeoutSecMin: 10,
  timeoutSecMax: 86_400,
  concurrencyMin: 1,
  concurrencyMax: 50,
} as const;

// ─── Parameter names ─────────────────────────────────────────────────────────

export const RUNBOOK_PARAM_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Names a parameter may not take. Each one changes how the shell or a common
 * interpreter behaves before the script's first line runs (PATH, IFS, BASH_ENV,
 * PS4 with `set -x`, LD_PRELOAD, …), so letting an editor-supplied value land in
 * one would turn "fill in a parameter" into "choose what code runs".
 */
export const RUNBOOK_RESERVED_PARAM_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "IFS",
  "ENV",
  "BASH_ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS1",
  "PS2",
  "PS4",
  "CDPATH",
  "GLOBIGNORE",
  "TMOUT",
  "PWD",
  "OLDPWD",
  "NODE_OPTIONS",
] as const;

export const RUNBOOK_RESERVED_PARAM_PREFIXES = ["LD_", "BASH_", "SUDO_", "RACKMAP_", "PYTHON", "PERL", "SSH_", "DYLD_"] as const;

/** Null when `name` is usable as a parameter, otherwise the reason it is not. */
export function runbookParamNameError(name: string): string | null {
  if (!RUNBOOK_PARAM_NAME_RE.test(name)) {
    return "Use A-Z, 0-9 and _, starting with a letter (max 64 characters)";
  }
  if ((RUNBOOK_RESERVED_PARAM_NAMES as readonly string[]).includes(name)) {
    return `${name} is reserved`;
  }
  const prefix = RUNBOOK_RESERVED_PARAM_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) return `Names starting with ${prefix} are reserved`;
  return null;
}

/** Compile an admin-supplied pattern as a FULL match. Throws if it does not compile. */
export function compileRunbookParamPattern(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`);
}

/**
 * Patterns run against values an editor supplies (up to paramValueMaxLength
 * chars) with no regex timeout, so reject the classic catastrophic-backtracking
 * shape: a quantified group whose body is itself quantified or alternated,
 * e.g. `(a+)+`, `(\w*)*`, `(a|aa)+`. Backreferences are refused too.
 */
export function runbookParamPatternRisk(pattern: string): string | null {
  if (/\\[1-9]|\\k</.test(pattern)) return "Backreferences are not allowed in parameter patterns";
  // Strip escapes and character classes so their contents don't count as structure.
  const flat = pattern.replace(/\\./g, "x").replace(/\[(?:\\.|[^\]])*\]/g, "x");
  if (/\((?:\?[:=!])?[^()]*(?:[+*]|\{\d+,\d*\}|\|)[^()]*\)(?:[+*]|\{\d+,\d*\})/.test(flat)) {
    return "Nested quantifiers such as (a+)+ can hang the API; simplify the pattern";
  }
  return null;
}

// ─── Parameter definitions ───────────────────────────────────────────────────

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const RunbookParamDef = z
  .object({
    name: z.string(),
    label: z.string().trim().max(100).optional(),
    description: z.string().max(500).optional(),
    type: z.enum(RUNBOOK_PARAM_TYPES),
    required: z.boolean().default(false),
    default: scalar.optional(),
    pattern: z.string().min(1).max(RUNBOOK_LIMITS.paramPatternMaxLength).optional(),
    enumValues: z.array(z.string().min(1).max(200)).max(100).optional(),
    maxLength: z.number().int().min(1).max(RUNBOOK_LIMITS.paramValueMaxLength).optional(),
  })
  .superRefine((d, ctx) => {
    const nameErr = runbookParamNameError(d.name);
    if (nameErr) ctx.addIssue({ code: "custom", path: ["name"], message: nameErr });

    if (d.pattern !== undefined) {
      if (d.type !== "string" && d.type !== "secret") {
        ctx.addIssue({ code: "custom", path: ["pattern"], message: "Patterns apply to string and secret parameters only" });
      } else {
        try {
          compileRunbookParamPattern(d.pattern);
          const risk = runbookParamPatternRisk(d.pattern);
          if (risk) ctx.addIssue({ code: "custom", path: ["pattern"], message: risk });
        } catch {
          ctx.addIssue({ code: "custom", path: ["pattern"], message: "Pattern is not a valid regular expression" });
        }
      }
    }
    if (d.type === "enum") {
      if (!d.enumValues || d.enumValues.length === 0) {
        ctx.addIssue({ code: "custom", path: ["enumValues"], message: "An enum parameter needs at least one value" });
      } else if (new Set(d.enumValues).size !== d.enumValues.length) {
        ctx.addIssue({ code: "custom", path: ["enumValues"], message: "Enum values must be unique" });
      }
    } else if (d.enumValues !== undefined) {
      ctx.addIssue({ code: "custom", path: ["enumValues"], message: "Only enum parameters take a value list" });
    }
    // A secret's default would be stored in plain text in the runbook definition
    // and shown to every reader — the opposite of what "secret" promises.
    if (d.type === "secret" && d.default !== undefined) {
      ctx.addIssue({ code: "custom", path: ["default"], message: "Secret parameters cannot have a default" });
    }
    if (d.default !== undefined) {
      const check = validateRunbookParamValue(d as RunbookParamDef, d.default);
      if (!check.ok) ctx.addIssue({ code: "custom", path: ["default"], message: `Default: ${check.error}` });
    }
  });
export type RunbookParamDef = z.infer<typeof RunbookParamDef>;

export const RunbookParamDefs = z
  .array(RunbookParamDef)
  .max(RUNBOOK_LIMITS.maxParams)
  .superRefine((defs, ctx) => {
    const seen = new Set<string>();
    defs.forEach((d, i) => {
      if (seen.has(d.name)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `Duplicate parameter ${d.name}` });
      seen.add(d.name);
    });
  });

// ─── Parameter values ────────────────────────────────────────────────────────

export type RunbookParamValueCheck = { ok: true; value: string } | { ok: false; error: string };

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Validate one value against its definition and normalise it to the string the
 * script will see. Run on the client for feedback, on the API at request time,
 * and again by the executor right before the value is written into the prelude.
 */
export function validateRunbookParamValue(def: RunbookParamDef, raw: unknown): RunbookParamValueCheck {
  let value: string;
  switch (def.type) {
    case "boolean":
      if (raw === true || raw === "true") return { ok: true, value: "true" };
      if (raw === false || raw === "false") return { ok: true, value: "false" };
      return { ok: false, error: "must be true or false" };
    case "number":
      value = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : typeof raw === "string" ? raw.trim() : "";
      if (!NUMBER_RE.test(value) || value.length > 64) return { ok: false, error: "must be a number" };
      return { ok: true, value };
    case "enum":
      if (typeof raw !== "string" || !(def.enumValues ?? []).includes(raw)) {
        return { ok: false, error: "must be one of the listed values" };
      }
      return { ok: true, value: raw };
    case "string":
    case "secret": {
      if (typeof raw !== "string") return { ok: false, error: "must be text" };
      value = raw;
      if (value.includes("\u0000")) return { ok: false, error: "must not contain NUL bytes" };
      const max = def.maxLength ?? RUNBOOK_LIMITS.paramValueMaxLength;
      if (value.length > max) return { ok: false, error: `must be at most ${max} characters` };
      if (def.pattern !== undefined) {
        let re: RegExp;
        try {
          re = compileRunbookParamPattern(def.pattern);
        } catch {
          return { ok: false, error: "has an invalid pattern" };
        }
        if (!re.test(value)) return { ok: false, error: "does not match the required format" };
      }
      return { ok: true, value };
    }
  }
}

/**
 * Resolve a full value set: defaults applied, required parameters enforced,
 * unknown names rejected (a name not in the definition list must never reach the
 * prelude). Empty strings count as "not provided".
 */
export function resolveRunbookParamValues(
  defs: RunbookParamDef[],
  input: Record<string, unknown>,
): { values: Record<string, string>; errors: Record<string, string> } {
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const known = new Set(defs.map((d) => d.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors[key] = "is not a parameter of this runbook";
  }
  for (const def of defs) {
    const provided = input[def.name];
    const raw = provided === undefined || provided === null || provided === "" ? def.default : provided;
    if (raw === undefined || raw === "") {
      if (def.required) errors[def.name] = "is required";
      continue;
    }
    const check = validateRunbookParamValue(def, raw);
    if (check.ok) values[def.name] = check.value;
    else errors[def.name] = check.error;
  }
  return { values, errors };
}

/** Replace secret values with "***" — what is stored in RunbookRun.params and shown in the UI. */
export function maskRunbookParamValues(defs: RunbookParamDef[], values: Record<string, string>): Record<string, string> {
  const secret = new Set(defs.filter((d) => d.type === "secret").map((d) => d.name));
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, secret.has(k) ? "***" : v]));
}

// ─── Targets ─────────────────────────────────────────────────────────────────

const idList = z.array(z.number().int().positive()).max(5000);

/**
 * Which servers a runbook runs on. Non-empty dimensions are ANDed, values within a
 * dimension are ORed; explicit `serverIds` are added on top, `excludeServerIds`
 * removed last. An empty selector matches NOTHING — never "every server".
 */
export const RunbookTargetSelector = z.object({
  serverIds: idList.default([]),
  tagIds: idList.default([]),
  environments: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  locationIds: idList.default([]),
  excludeServerIds: idList.default([]),
  onlyUp: z.boolean().default(false),
});
export type RunbookTargetSelector = z.infer<typeof RunbookTargetSelector>;

export function isEmptyRunbookSelector(sel: Partial<RunbookTargetSelector> | null | undefined): boolean {
  if (!sel) return true;
  return (
    (sel.serverIds?.length ?? 0) === 0 &&
    (sel.tagIds?.length ?? 0) === 0 &&
    (sel.environments?.length ?? 0) === 0 &&
    (sel.locationIds?.length ?? 0) === 0
  );
}

export const RUNBOOK_TARGET_WARNINGS = ["down", "vault_required", "no_credentials"] as const;
export type RunbookTargetWarning = (typeof RUNBOOK_TARGET_WARNINGS)[number];

// ─── Schedule ────────────────────────────────────────────────────────────────

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
/** Nicknames are expanded here rather than left to croner, so both sides agree on them. */
const NICKNAMES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function expandSchedule(schedule: string): string {
  const s = schedule.trim();
  return NICKNAMES[s.toLowerCase()] ?? s;
}

/**
 * Vixie-subset check for one field: `*`, numbers, ranges, lists and steps, plus
 * three-letter names in the month/day-of-week fields. croner alone would also take
 * `L`, `W`, `#` and `?`, which the cron editor refuses; keeping one dialect means a
 * schedule copied between a runbook and a crontab means the same thing in both.
 */
function vixieFieldOk(field: string, names: string[] | null): boolean {
  const unit = names ? `(?:\\d+|${names.join("|")})` : "\\d+";
  const atom = `(?:\\*|${unit}(?:-${unit})?)(?:/\\d+)?`;
  return new RegExp(`^${atom}(?:,${atom})*$`, "i").test(field);
}

/** Null when the schedule is valid for a runbook, otherwise a message. */
export function runbookScheduleError(schedule: string, timezone = "UTC"): string | null {
  const s = schedule.trim();
  if (s.length === 0) return "Schedule is empty";
  if (s.length > 100) return "Schedule is too long";
  if (s.startsWith("@")) {
    if (s.toLowerCase() === "@reboot") return "@reboot is not supported for runbooks";
    if (!(s.toLowerCase() in NICKNAMES)) return `Unknown schedule nickname ${s}`;
  } else {
    const fields = s.split(/\s+/);
    if (fields.length !== 5) return "Use five fields: minute hour day-of-month month day-of-week";
    const named: (string[] | null)[] = [null, null, null, MONTHS, DAYS];
    for (let i = 0; i < 5; i++) {
      if (!vixieFieldOk(fields[i]!, named[i] ?? null)) return `Field ${i + 1} ("${fields[i]}") is not valid cron syntax`;
    }
  }
  try {
    new Cron(expandSchedule(s), { mode: "5-part", domAndDow: false, paused: true, timezone });
  } catch (err) {
    return err instanceof Error ? err.message.replace(/^CronPattern:\s*/, "") : "Invalid schedule";
  }
  return null;
}

/** Next fire time strictly after `from`, in the schedule's timezone. */
export function nextRunbookRun(schedule: string, timezone: string, from: Date): Date | null {
  return new Cron(expandSchedule(schedule), { mode: "5-part", domAndDow: false, paused: true, timezone }).nextRun(from);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── Runbook CRUD ────────────────────────────────────────────────────────────

/** UTF-8 byte length without TextEncoder (this package builds against the bare ES lib). */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const scriptField = z
  .string()
  .min(1, "Script is empty")
  .refine((s) => !s.includes("\u0000"), "Script must not contain NUL bytes")
  .refine((s) => utf8Length(s) <= RUNBOOK_LIMITS.scriptMaxBytes, "Script is larger than 64 KB");

const scheduleParamsField = z.record(z.string(), scalar);

/** Fields without defaults, so the PATCH schema can make every one optional without refilling defaults. */
const runbookFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).nullable(),
  script: scriptField,
  interpreter: z.enum(RUNBOOK_INTERPRETERS),
  parameters: RunbookParamDefs,
  runAs: z.enum(RUNBOOK_RUN_AS),
  timeoutSec: z.number().int().min(RUNBOOK_LIMITS.timeoutSecMin).max(RUNBOOK_LIMITS.timeoutSecMax),
  concurrency: z.number().int().min(RUNBOOK_LIMITS.concurrencyMin).max(RUNBOOK_LIMITS.concurrencyMax),
  maxFailures: z.number().int().min(1).max(100_000).nullable(),
  requireApproval: z.boolean(),
  targetSelector: RunbookTargetSelector.refine((s) => !isEmptyRunbookSelector(s), {
    message: "Select at least one server, tag, environment or location",
  }),
  allowTargetOverride: z.boolean(),
  schedule: z.string().trim().max(100).nullable(),
  scheduleTimezone: z.string().trim().min(1).max(64).refine(isValidTimezone, "Unknown timezone"),
  scheduleEnabled: z.boolean(),
  /** Parameter values for scheduled runs. Stored encrypted; secrets come back as "***". */
  scheduleParams: scheduleParamsField,
};

/**
 * Cross-field rules, applied to the create body and — by the API — to the merged
 * result of a PATCH (a patch may set only one side of a rule).
 */
export function runbookConfigIssues(r: {
  schedule?: string | null;
  scheduleTimezone?: string;
  scheduleEnabled?: boolean;
  requireApproval?: boolean;
}): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const schedule = r.schedule?.trim() ? r.schedule.trim() : null;
  if (schedule) {
    const err = runbookScheduleError(schedule, r.scheduleTimezone ?? "UTC");
    if (err) issues.push({ path: "schedule", message: err });
    // v1 rule: nobody is around to approve a 03:00 run, and auto-approving it would
    // make requireApproval meaningless.
    if (r.requireApproval) {
      issues.push({ path: "schedule", message: "A runbook that requires approval cannot have a schedule" });
    }
  }
  if (r.scheduleEnabled && !schedule) {
    issues.push({ path: "scheduleEnabled", message: "Set a schedule before enabling it" });
  }
  return issues;
}

export const RunbookCreateInput = z
  .object({
    ...runbookFields,
    description: runbookFields.description.optional(),
    interpreter: runbookFields.interpreter.default("bash"),
    parameters: runbookFields.parameters.default([]),
    runAs: runbookFields.runAs.default("sshUser"),
    timeoutSec: runbookFields.timeoutSec.default(300),
    concurrency: runbookFields.concurrency.default(5),
    maxFailures: runbookFields.maxFailures.optional(),
    requireApproval: runbookFields.requireApproval.default(false),
    allowTargetOverride: runbookFields.allowTargetOverride.default(true),
    schedule: runbookFields.schedule.optional(),
    scheduleTimezone: runbookFields.scheduleTimezone.default("UTC"),
    scheduleEnabled: runbookFields.scheduleEnabled.default(false),
    scheduleParams: scheduleParamsField.optional(),
  })
  .superRefine((r, ctx) => {
    for (const issue of runbookConfigIssues(r)) ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
  });
export type RunbookCreateInput = z.infer<typeof RunbookCreateInput>;
/** What a client sends (defaults not yet applied). */
export type RunbookCreateBody = z.input<typeof RunbookCreateInput>;

export const RunbookUpdateInput = z.object(runbookFields).partial();
export type RunbookUpdateInput = z.infer<typeof RunbookUpdateInput>;

// ─── Runs ────────────────────────────────────────────────────────────────────

export const RunbookRunRequestInput = z.object({
  params: z.record(z.string(), scalar).default({}),
  /** Narrow the runbook's own target set. Every id must already be in it. */
  targets: z.object({ serverIds: z.array(z.number().int().positive()).min(1).max(5000) }).optional(),
  /** Run a connectivity/sudo probe instead of the script. Never needs approval. */
  dryRun: z.boolean().default(false),
});
export type RunbookRunRequestInput = z.infer<typeof RunbookRunRequestInput>;
export type RunbookRunRequestBody = z.input<typeof RunbookRunRequestInput>;

export const RunbookPreviewTargetsInput = z.object({
  targets: z.object({ serverIds: z.array(z.number().int().positive()).min(1).max(5000) }).optional(),
});
export type RunbookPreviewTargetsInput = z.infer<typeof RunbookPreviewTargetsInput>;

export const RunbookRejectInput = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type RunbookRejectInput = z.infer<typeof RunbookRejectInput>;

export const RunbookRerunInput = z.object({
  /** Only hosts that did not succeed last time. */
  onlyFailed: z.boolean().default(false),
});
export type RunbookRerunInput = z.infer<typeof RunbookRerunInput>;

export const RunbookRunListQuery = z.object({
  runbookId: z.coerce.number().int().positive().optional(),
  status: z.enum(RUNBOOK_RUN_STATUSES).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type RunbookRunListQuery = z.infer<typeof RunbookRunListQuery>;

export const RunbookOutputQuery = z.object({
  stdoutFrom: z.coerce.number().int().min(0).default(0),
  stderrFrom: z.coerce.number().int().min(0).default(0),
});
export type RunbookOutputQuery = z.infer<typeof RunbookOutputQuery>;

// ─── Response shapes ─────────────────────────────────────────────────────────

export interface RunbookUserRef {
  id: string;
  name: string;
  email: string;
}

export interface RunbookRunSummary {
  total: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  skipped: number;
}

export interface RunbookLastRun {
  id: number;
  status: RunbookRunStatus;
  dryRun: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunbookDto {
  id: number;
  name: string;
  description: string | null;
  script: string;
  interpreter: RunbookInterpreter;
  parameters: RunbookParamDef[];
  runAs: RunbookRunAs;
  timeoutSec: number;
  concurrency: number;
  maxFailures: number | null;
  requireApproval: boolean;
  targetSelector: RunbookTargetSelector;
  allowTargetOverride: boolean;
  schedule: string | null;
  scheduleTimezone: string;
  scheduleEnabled: boolean;
  /** Values used by scheduled runs; secret values are "***". */
  scheduleParams: Record<string, string>;
  nextScheduledAt: string | null;
  version: number;
  createdBy: RunbookUserRef | null;
  updatedBy: RunbookUserRef | null;
  createdAt: string;
  updatedAt: string;
  lastRun: RunbookLastRun | null;
}

export interface RunbookTargetPreviewItem {
  serverId: number;
  hostname: string;
  ip: string;
  environment: string | null;
  lastStatus: string;
  warnings: RunbookTargetWarning[];
}

export interface RunbookTargetPreview {
  targets: RunbookTargetPreviewItem[];
  total: number;
  /** The selector matched more servers than RUNBOOK_MAX_TARGETS; a run would be refused. */
  exceeded: boolean;
  maxTargets: number;
  /** Whether a real (non-dry) run by the caller would wait for a second person. */
  requiresApproval: boolean;
  /** Whether the run dialog must ask the caller to type RUN. */
  requiresConfirmation: boolean;
}

export interface RunbookHostResultDto {
  id: number;
  serverId: number | null;
  hostname: string;
  status: RunbookHostStatus;
  errorCode: string | null;
  exitCode: number | null;
  stdoutLength: number;
  stderrLength: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface RunbookRunDto {
  id: number;
  runbookId: number;
  runbookName: string;
  runbookVersion: number;
  interpreter: RunbookInterpreter;
  runAs: RunbookRunAs;
  timeoutSec: number;
  concurrency: number;
  maxFailures: number | null;
  params: Record<string, string>;
  targetServerIds: number[];
  triggeredBy: "user" | "schedule" | "api";
  dryRun: boolean;
  status: RunbookRunStatus;
  requestedBy: RunbookUserRef | null;
  approvedBy: RunbookUserRef | null;
  approvedAt: string | null;
  rejectedBy: RunbookUserRef | null;
  rejectionReason: string | null;
  cancelRequestedAt: string | null;
  cancelledBy: RunbookUserRef | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: RunbookRunSummary | null;
  error: string | null;
  createdAt: string;
  /** When a pending run would expire unapproved. */
  approvalExpiresAt: string | null;
}

export interface RunbookRunDetailDto extends RunbookRunDto {
  scriptSnapshot: string;
  hosts: RunbookHostResultDto[];
  /** The runbook as it is now, when it has changed since this run was requested. */
  currentVersion: number | null;
  currentScript: string | null;
}

export interface RunbookRunListResponse {
  items: RunbookRunDto[];
  nextCursor: number | null;
}

export interface RunbookHostOutputResponse {
  status: RunbookHostStatus;
  stdout: string;
  stderr: string;
  /** Character offsets to pass as stdoutFrom / stderrFrom on the next call. */
  stdoutNext: number;
  stderrNext: number;
  stdoutLength: number;
  stderrLength: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** No more output will be appended (the host finished). */
  done: boolean;
}
