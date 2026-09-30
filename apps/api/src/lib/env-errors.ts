/**
 * Human-readable rendering of a failed environment validation.
 *
 * Why this exists: env.ts used to print `z.treeifyError(...)` straight to
 * console.error. treeifyError nests the actual messages at depth 3 and Node's
 * console renders objects to depth 2, so every reason came out as the literal
 * string `[Array]`:
 *
 *     Invalid environment: {
 *       errors: [],
 *       properties: { BETTER_AUTH_SECRET: { errors: [Array] } }
 *     }
 *
 * The operator learned which variable was wrong and nothing else — not that it
 * was missing, not what it is for, not how to produce a valid one. This module
 * turns the same ZodError into a block per variable with a curated explanation
 * and a command that produces a working value.
 *
 * Everything here is pure: it reads, formats and returns a string. Nothing
 * logs, exits or mutates. That is what makes it testable, and the tests are the
 * only guard that a secret never ends up in a crash log.
 */

/** Columns the prose is wrapped to, before the 4-space block indent. */
const WRAP_WIDTH = 74;

/**
 * Names whose VALUE must never be echoed back. Startup errors end up in
 * `docker compose logs`, in pasted bug reports and in CI output, so a variable
 * that is wrong is described ("set, but invalid") and never quoted. The match
 * is on the name, deliberately broad, and applied before anything is printed.
 *
 * PASS is listed separately from PASSWORD/PASSPHRASE on purpose: SMTP_PASS
 * matches none of the longer forms, and a wrong SMTP password is still a
 * password. URL is here because DATABASE_URL and NOTIFY_WEBHOOK_URL carry
 * credentials inline.
 */
const SENSITIVE_NAME = /SECRET|PASSWORD|PASSPHRASE|PASS|KEY|TOKEN|URL|CREDENTIAL/;

/** What a variable is for, and how to produce a valid value for it. */
type EnvHint = {
  /** Prose. Word-wrapped to the terminal. */
  summary: string;
  /** Printed verbatim — commands and examples, where spacing is meaningful. */
  fix?: string[];
};

/**
 * The variables a first-run operator can realistically get wrong. Anything not
 * listed falls back to zod's own message, which is fine for the hundred-odd
 * tuning knobs nobody sets by hand on day one.
 */
const HINTS: Record<string, EnvHint> = {
  BETTER_AUTH_SECRET: {
    summary: "Session-signing secret, 16+ characters.",
    fix: ["Generate one:  openssl rand -hex 32"],
  },
  APP_ENCRYPTION_KEY: {
    // The schema attaches the "one of the two" refinement to this path, so this
    // block is what an operator who set NEITHER variable sees. It has to name
    // both, or the advice sends them to the wrong one.
    summary:
      "Master key for at-rest encryption (server passwords, SSH credentials, " +
      "alert channel tokens). Either APP_ENCRYPTION_KEY or " +
      "APP_ENCRYPTION_PASSPHRASE must be set; the key form is 32 random bytes, " +
      "base64-encoded.",
    fix: ["Generate one:  openssl rand -base64 32"],
  },
  APP_ENCRYPTION_PASSPHRASE: {
    summary:
      "Passphrase form of the at-rest master key, 8+ characters. Either " +
      "APP_ENCRYPTION_KEY or APP_ENCRYPTION_PASSPHRASE must be set.",
    fix: ["Generate one:  openssl rand -base64 32"],
  },
  VAULT_PASSPHRASE: {
    summary:
      "Optional second passphrase gating the credential vault. Leave it unset " +
      "unless you mean to use it.",
  },
  DATABASE_URL: {
    summary:
      "PostgreSQL connection string, e.g. " +
      "postgresql://user:password@postgres:5432/rackmap. A malformed one is " +
      "almost always a password containing @ : / or ? that was not " +
      "percent-encoded — \"/\" ends the authority early, so the host and port " +
      "are read out of the middle of the password. RackMap's Docker setup " +
      "encodes POSTGRES_PASSWORD for you (apps/api/entrypoint.sh), so reaching " +
      "this message means DOCKER_DATABASE_URL was written by hand.",
    fix: [
      "Encode the password, then paste the result into the URL:",
      "  node -e 'console.log(encodeURIComponent(process.argv[1]))' 'your-password'",
    ],
  },
  BETTER_AUTH_URL: {
    summary:
      "Base URL the API itself is reached at, scheme included — http://api:3001 " +
      "under Docker, http://localhost:3000 bare-metal.",
  },
  WEB_ORIGIN: {
    summary:
      "Origin the browser loads the UI from, scheme included and no trailing " +
      "path — e.g. http://localhost:8080. It is also the CORS fallback when " +
      "TRUSTED_ORIGINS is unset, so getting it wrong logs everyone out.",
  },
  TRUSTED_ORIGINS: {
    summary:
      "Comma-separated list of origins allowed to call this API, e.g. " +
      "https://rackmap.example.com,http://192.168.1.10:8080. Leave it unset to " +
      "fall back to WEB_ORIGIN.",
  },
  PUBLIC_BASE_URL: {
    summary:
      "Externally reachable base URL of this instance, e.g. " +
      "https://rackmap.example.com. Used for heartbeat check-in URLs and links " +
      "in alerts. Must be an absolute URL or unset — an empty value is treated " +
      "as unset.",
  },
  PORT: {
    summary: "TCP port the API listens on. A whole number; 3001 under Docker.",
  },
  NODE_ENV: {
    summary:
      "One of development, test or production. Anything reachable by someone " +
      "else is production — it is what stops the published demo accounts from " +
      "being seeded.",
  },
  BILLING_MODE: {
    summary:
      "One of disabled or simulated. \"simulated\" marks orders paid without a " +
      "payment gateway and belongs on local demos only.",
  },
  SSH_HOST_POLICY: {
    summary:
      "One of accept-any or tofu. \"tofu\" pins a host key on first sight and " +
      "aborts the handshake if it later changes.",
  },
};

/** One rendered block: a variable, its state, and what to do about it. */
export type StartupProblem = {
  /** Variable name, printed first so the eye lands on it. */
  name: string;
  /** Short state on the same line: "missing", "(set, but invalid)", … */
  status: string;
  /** Prose. Word-wrapped. */
  summary?: string;
  /** Printed verbatim — commands, examples. */
  lines?: string[];
};

/** The subset of a ZodError this module needs. Structural so tests can fake it. */
type EnvValidationError = {
  readonly issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>;
};

export type FormatEnvProblemsOptions = {
  /**
   * The environment the schema was parsed from. Consulted ONLY to tell
   * "missing" apart from "set, but invalid" — no value from it is ever printed
   * for a name matching SENSITIVE_NAME. Defaults to process.env.
   */
  values?: Record<string, string | undefined>;
  /**
   * Running inside the compose stack. Decides which .env file and which start
   * command the closing line names. Defaults to IN_DOCKER === "true".
   */
  inDocker?: boolean;
};

/**
 * Renders a startup failure: a headline, one indented block per problem, and a
 * closing line telling the operator where to make the change and how to retry.
 * Shared with preflight.ts so a bad environment and an unreachable database
 * look like the same program talking.
 */
export function formatStartupError(title: string, problems: StartupProblem[], closing?: string): string {
  const out: string[] = [`RackMap cannot start — ${title}`];
  const width = problems.reduce((max, p) => Math.max(max, p.name.length), 0);

  for (const problem of problems) {
    out.push("");
    out.push(`  ${problem.name.padEnd(width)}   ${problem.status}`);
    if (problem.summary) {
      for (const line of wrapText(problem.summary, WRAP_WIDTH)) out.push(`    ${line}`);
    }
    for (const line of problem.lines ?? []) out.push(`    ${line}`);
  }

  if (closing) {
    out.push("");
    out.push(closing);
  }
  return out.join("\n");
}

/**
 * Turns a failed `EnvSchema.safeParse` into the message an operator actually
 * needs. Issues are grouped by variable, so a field failing two checks is one
 * block rather than two.
 */
export function formatEnvProblems(error: EnvValidationError, opts: FormatEnvProblemsOptions = {}): string {
  const values = opts.values ?? (process.env as Record<string, string | undefined>);
  const inDocker = opts.inDocker ?? process.env["IN_DOCKER"] === "true";

  const order: string[] = [];
  const messagesByName = new Map<string, string[]>();
  for (const issue of error.issues) {
    // Depth 1 is the variable name; the schema is flat, so there is no deeper
    // path. An issue with no path at all is an object-level check that was not
    // routed to a variable — label it rather than dropping it.
    const first = issue.path[0];
    const name = first === undefined ? "(environment)" : String(first);
    let messages = messagesByName.get(name);
    if (!messages) {
      messages = [];
      messagesByName.set(name, messages);
      order.push(name);
    }
    if (issue.message && !messages.includes(issue.message)) messages.push(issue.message);
  }

  if (order.length === 0) {
    return formatStartupError("the environment did not validate.", [], closingLine(inDocker));
  }

  const problems: StartupProblem[] = order.map((name) => {
    const hint = HINTS[name];
    const problem: StartupProblem = { name, status: describeValue(name, values[name]) };
    if (hint) {
      problem.summary = hint.summary;
      if (hint.fix) problem.lines = hint.fix;
    } else {
      // No curated hint: zod's own message is still better than nothing, and
      // for the tuning knobs ("Too small: expected number to be >=5000") it is
      // usually enough.
      problem.summary = (messagesByName.get(name) ?? []).join(" ");
    }
    return problem;
  });

  const count = problems.length;
  return formatStartupError(
    `${count} problem${count === 1 ? "" : "s"} with the environment:`,
    problems,
    closingLine(inDocker),
  );
}

/** Where to make the change, and the command that retries it. */
export function closingLine(inDocker: boolean): string {
  return inDocker
    ? "Set these in .env in the repository root, then:  make up"
    : "Set these in apps/api/.env, then:  pnpm dev";
}

/**
 * The status shown beside the variable name. Never the value itself for a
 * sensitive name — a wrong secret in a log is still a secret in a log.
 */
export function describeValue(name: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return "missing";
  if (SENSITIVE_NAME.test(name)) return "(set, but invalid)";
  const shown = raw.length > 40 ? `${raw.slice(0, 37)}…` : raw;
  return `invalid: ${JSON.stringify(shown)}`;
}

/**
 * A connection string with the password replaced, safe to print. Used by
 * preflight to say WHICH database it could not reach without leaking how to
 * log in to it.
 */
export function redactDatabaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "(unparseable)";
  }
  const user = url.username ? `${url.username}${url.password ? ":***" : ""}@` : "";
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${user}${url.hostname}${port}${url.pathname}`;
}

/**
 * Validates the shape of a PostgreSQL connection string, returning the reason
 * it is unusable or null when it is fine.
 *
 * This is shape only — it never opens a socket. Its whole job is to move the
 * failure from "Prisma threw inside ensure-baseline.mjs, under a banner about
 * a database in an unknown state" to "DATABASE_URL is malformed", which is a
 * problem the operator can fix in .env instead of reading MIGRATION.md.
 */
export function databaseUrlProblem(raw: string): string | null {
  if (raw.trim() === "") return "DATABASE_URL is empty.";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The common failure: an unencoded "/" or "?" in the password ends the
    // authority early, and what follows parses as a port.
    return "DATABASE_URL is not a valid URL — most often an unencoded character in the password.";
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return `DATABASE_URL must start with postgresql:// or postgres://, not ${url.protocol}//`;
  }
  if (!url.hostname) return "DATABASE_URL has no hostname.";
  if (url.port !== "" && !/^\d+$/.test(url.port)) return `DATABASE_URL has a non-numeric port (${url.port}).`;
  if (url.pathname.replace(/^\//, "") === "") return "DATABASE_URL has no database name after the host.";
  return null;
}

/** Greedy word wrap. Long single words are left alone rather than broken. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out;
}
