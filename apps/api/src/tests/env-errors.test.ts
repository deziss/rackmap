import { describe, it, expect } from "vitest";
import {
  databaseUrlProblem,
  describeValue,
  formatEnvProblems,
  redactDatabaseUrl,
} from "../lib/env-errors.js";
import {
  DEV_DEFAULT_ADMIN_PASSWORD,
  isWeakAdminPassword,
  MIN_ADMIN_PASSWORD_LENGTH,
  resolveAdminPassword,
  WEAK_DEFAULTS,
} from "../lib/admin-password.js";
import { EnvSchema } from "../env.js";

/**
 * The startup error renderer. These are the guarantees an operator relies on
 * when they paste a crash log into an issue: it names the variable, it tells
 * them how to produce a valid value, and it never quotes the value itself.
 *
 * Nothing here touches the database — but vitest's shared setup.ts does, so the
 * suite still needs the test Postgres.
 */

/** A ZodError-shaped stand-in; the renderer only ever reads `issues`. */
const issues = (...list: Array<[string, string]>) => ({
  issues: list.map(([path, message]) => ({ path: [path], message })),
});

/** A complete environment that passes EnvSchema, to mutate per case. */
const VALID_ENV = {
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  APP_ENCRYPTION_KEY: "dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=",
  DATABASE_URL: "postgresql://rackmap:s3cret@postgres:5432/rackmap?schema=public",
};

describe("formatEnvProblems — secrets", () => {
  it.each([
    ["BETTER_AUTH_SECRET", "hunter2-actual-session-secret"],
    ["APP_ENCRYPTION_KEY", "cnVubmluZy1tYXN0ZXIta2V5LXZhbHVl"],
    ["APP_ENCRYPTION_PASSPHRASE", "correct-horse-battery-staple"],
    ["VAULT_PASSPHRASE", "vault-passphrase-in-the-clear"],
    ["DATABASE_URL", "postgresql://rackmap:pa55word@db:5432/rackmap"],
    ["SMTP_PASS", "smtp-password-in-the-clear"],
    ["NOTIFY_TELEGRAM_BOT_TOKEN", "1234:telegram-bot-token-value"],
    ["LICENCIA_API_KEY", "licencia-api-key-value"],
  ])("never echoes the value of %s", (name, value) => {
    const out = formatEnvProblems(issues([name, "nope"]), {
      values: { [name]: value },
      inDocker: true,
    });
    expect(out).toContain(name);
    expect(out).toContain("(set, but invalid)");
    expect(out).not.toContain(value);
  });

  it("says 'missing' rather than '(set, but invalid)' when the variable is unset", () => {
    const out = formatEnvProblems(issues(["BETTER_AUTH_SECRET", "nope"]), { values: {}, inDocker: true });
    expect(out).toContain("BETTER_AUTH_SECRET   missing");
    expect(out).not.toContain("(set, but invalid)");
  });

  it("treats a blank value as missing — compose passes empty strings, not absences", () => {
    expect(describeValue("BETTER_AUTH_SECRET", "")).toBe("missing");
    expect(describeValue("BETTER_AUTH_SECRET", "   ")).toBe("missing");
  });

  it("does echo a non-sensitive value, so a typo is visible", () => {
    const out = formatEnvProblems(issues(["PORT", "expected number"]), {
      values: { PORT: "thirty-oh-one" },
      inDocker: true,
    });
    expect(out).toContain('invalid: "thirty-oh-one"');
  });
});

describe("formatEnvProblems — actionability", () => {
  it("names the variable and gives a command that produces a valid value", () => {
    const out = formatEnvProblems(issues(["BETTER_AUTH_SECRET", "Too small: expected string"]), {
      values: {},
      inDocker: true,
    });
    expect(out).toContain("BETTER_AUTH_SECRET");
    expect(out).toContain("openssl rand -hex 32");
    // The headline has to read as a refusal to start, not as a stack trace.
    expect(out).toContain("RackMap cannot start — 1 problem with the environment:");
  });

  it("names BOTH encryption variables for the either/or refinement", () => {
    // The schema attaches the refine issue to APP_ENCRYPTION_KEY, so a block
    // that only mentions that name sends an operator who meant to use the
    // passphrase to the wrong variable.
    const out = formatEnvProblems(
      issues([
        "APP_ENCRYPTION_KEY",
        "Either APP_ENCRYPTION_KEY or APP_ENCRYPTION_PASSPHRASE must be provided",
      ]),
      { values: {}, inDocker: true },
    );
    expect(out).toContain("APP_ENCRYPTION_KEY");
    expect(out).toContain("APP_ENCRYPTION_PASSPHRASE");
    expect(out).toContain("openssl rand -base64 32");
  });

  it("counts problems and renders one block each", () => {
    const out = formatEnvProblems(issues(["BETTER_AUTH_SECRET", "a"], ["PORT", "b"]), {
      values: {},
      inDocker: true,
    });
    expect(out).toContain("2 problems with the environment:");
    expect(out).toContain("BETTER_AUTH_SECRET");
    expect(out).toContain("PORT");
  });

  it("groups repeated issues for one variable into a single block", () => {
    const out = formatEnvProblems(issues(["PORT", "a"], ["PORT", "b"]), { values: {}, inDocker: true });
    expect(out).toContain("1 problem with the environment:");
  });

  it("falls back to zod's own message for a variable with no curated hint", () => {
    const out = formatEnvProblems(issues(["PING_INTERVAL_MS", "Too small: expected >=5000"]), {
      values: { PING_INTERVAL_MS: "10" },
      inDocker: true,
    });
    expect(out).toContain("PING_INTERVAL_MS");
    expect(out).toContain("Too small: expected >=5000");
  });
});

describe("formatEnvProblems — closing line", () => {
  const dockerOut = formatEnvProblems(issues(["BETTER_AUTH_SECRET", "x"]), { values: {}, inDocker: true });
  const bareOut = formatEnvProblems(issues(["BETTER_AUTH_SECRET", "x"]), { values: {}, inDocker: false });

  it("differs between Docker and bare metal", () => {
    expect(dockerOut).not.toEqual(bareOut);
  });

  it("points Docker at the repo-root .env and make up", () => {
    expect(dockerOut).toContain(".env in the repository root");
    expect(dockerOut).toContain("make up");
    expect(dockerOut).not.toContain("pnpm dev");
  });

  it("points bare metal at apps/api/.env and pnpm dev", () => {
    expect(bareOut).toContain("apps/api/.env");
    expect(bareOut).toContain("pnpm dev");
    expect(bareOut).not.toContain("make up");
  });

  it("defaults to IN_DOCKER when the caller does not say", () => {
    const before = process.env["IN_DOCKER"];
    try {
      process.env["IN_DOCKER"] = "true";
      expect(formatEnvProblems(issues(["PORT", "x"]), { values: {} })).toContain("make up");
      delete process.env["IN_DOCKER"];
      expect(formatEnvProblems(issues(["PORT", "x"]), { values: {} })).toContain("pnpm dev");
    } finally {
      if (before === undefined) delete process.env["IN_DOCKER"];
      else process.env["IN_DOCKER"] = before;
    }
  });
});

describe("EnvSchema → formatEnvProblems", () => {
  it("renders a real missing-secret failure without leaking anything", () => {
    const { BETTER_AUTH_SECRET: _omitted, ...rest } = VALID_ENV;
    const parsed = EnvSchema.safeParse(rest);
    if (parsed.success) throw new Error("expected EnvSchema to reject a missing BETTER_AUTH_SECRET");
    const out = formatEnvProblems(parsed.error, { values: rest, inDocker: true });
    expect(out).toContain("BETTER_AUTH_SECRET   missing");
    expect(out).toContain("openssl rand -hex 32");
    expect(out).not.toContain(VALID_ENV.APP_ENCRYPTION_KEY);
  });

  it("rejects a malformed DATABASE_URL and explains percent-encoding", () => {
    // The original bug: `openssl rand -base64 32` emits "/" most of the time,
    // and an unencoded "/" in the password ends the URL authority early.
    const bad = { ...VALID_ENV, DATABASE_URL: "postgresql://rackmap:ab/cd@postgres:5432/rackmap" };
    const parsed = EnvSchema.safeParse(bad);
    if (parsed.success) throw new Error("expected EnvSchema to reject a malformed DATABASE_URL");
    const out = formatEnvProblems(parsed.error, { values: bad, inDocker: true });
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("percent-encoded");
    expect(out).toContain("encodeURIComponent");
    expect(out).toContain("DOCKER_DATABASE_URL");
    expect(out).not.toContain("ab/cd");
  });

  it("still accepts an unset DATABASE_URL — bare-metal dev relies on the default", () => {
    const { DATABASE_URL: _omitted, ...rest } = VALID_ENV;
    const parsed = EnvSchema.safeParse(rest);
    if (!parsed.success) throw new Error(`expected the DATABASE_URL default to validate: ${parsed.error.message}`);
    expect(parsed.data.DATABASE_URL).toContain("localhost:5432");
  });
});

describe("databaseUrlProblem", () => {
  it.each([
    ["postgresql://postgres:postgres@localhost:5432/server_inventory?schema=public"],
    ["postgresql://rackmap:enc%2Foded@postgres:5432/rackmap"],
    ["postgres://rackmap@db.internal/rackmap"],
  ])("accepts %s", (url) => {
    expect(databaseUrlProblem(url)).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["postgresql://rackmap:ab/cd@postgres:5432/rackmap", "unencoded slash in the password"],
    ["postgresql://rackmap:ab?cd@postgres:5432/rackmap", "unencoded question mark"],
    ["mysql://rackmap:pw@db:3306/rackmap", "wrong protocol"],
    ["postgresql://rackmap:pw@postgres:5432", "no database name after the host"],
    ["postgresql://rackmap:pw@postgres:5432/", "no database name after the host"],
    ["not a url at all", "not a url"],
  ])("rejects %s (%s)", (url) => {
    expect(databaseUrlProblem(url)).not.toBeNull();
  });
});

describe("redactDatabaseUrl", () => {
  it("keeps the host and database but drops the password", () => {
    const out = redactDatabaseUrl("postgresql://rackmap:s3cret@postgres:5432/rackmap?schema=public");
    expect(out).toBe("postgresql://rackmap:***@postgres:5432/rackmap");
    expect(out).not.toContain("s3cret");
  });

  it("never throws on an unparseable value", () => {
    expect(redactDatabaseUrl("garbage")).toBe("(unparseable)");
  });
});

describe("admin password policy", () => {
  it("rejects the empty string — the case `??` in seed.ts used to wave through", () => {
    // docker-compose.yml sends SEED_ADMIN_PASSWORD: "" when it is unset in
    // .env, so this is the value a default install actually produces.
    expect(isWeakAdminPassword("")).toBe(true);
    expect(isWeakAdminPassword("   ")).toBe(true);
  });

  it("rejects every password published in this repository", () => {
    for (const weak of WEAK_DEFAULTS) expect(isWeakAdminPassword(weak)).toBe(true);
  });

  it(`rejects anything shorter than ${MIN_ADMIN_PASSWORD_LENGTH} characters`, () => {
    expect(isWeakAdminPassword("a".repeat(MIN_ADMIN_PASSWORD_LENGTH - 1))).toBe(true);
    expect(isWeakAdminPassword("a".repeat(MIN_ADMIN_PASSWORD_LENGTH))).toBe(false);
  });

  it("accepts a strong password", () => {
    expect(isWeakAdminPassword("Tr0ub4dor&3-horse-battery")).toBe(false);
  });

  it("substitutes the development default for unset and blank", () => {
    expect(resolveAdminPassword(undefined)).toBe(DEV_DEFAULT_ADMIN_PASSWORD);
    expect(resolveAdminPassword("")).toBe(DEV_DEFAULT_ADMIN_PASSWORD);
    expect(resolveAdminPassword("  ")).toBe(DEV_DEFAULT_ADMIN_PASSWORD);
    expect(resolveAdminPassword("Tr0ub4dor&3-horse")).toBe("Tr0ub4dor&3-horse");
  });

  it("keeps the development default inside WEAK_DEFAULTS, so production still refuses it", () => {
    expect(isWeakAdminPassword(DEV_DEFAULT_ADMIN_PASSWORD)).toBe(true);
  });
});
