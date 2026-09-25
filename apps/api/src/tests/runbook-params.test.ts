import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RunbookCreateInput,
  RunbookParamDef,
  resolveRunbookParamValues,
  runbookParamNameError,
  runbookScheduleError,
  validateRunbookParamValue,
} from "@inv/shared";
import { buildPrelude, composeRunbookScript, createSecretMasker, RunbookParamError } from "../services/runbook-params.js";

/**
 * Parameters are the one place an editor's input reaches a script that may run
 * as root on every host. These tests execute the generated prelude with a real
 * local /bin/sh, so "the value arrives verbatim and nothing in it runs" is
 * checked against an actual shell rather than against our idea of one.
 */

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rackmap-rb-params-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const def = (over: Partial<RunbookParamDef> & { name: string }): RunbookParamDef =>
  RunbookParamDef.parse({ type: "string", ...over });

/** Source the prelude in /bin/sh, then print one variable exactly. */
function shellValue(prelude: string, varName: string): string {
  const file = path.join(dir, `prelude-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, prelude);
  // The value is never on this command line: it only exists inside the file.
  return execFileSync("/bin/sh", ["-c", `. "$1"; printf %s "$${varName}"`, "sh", file], { encoding: "utf8" });
}

const HOSTILE = [
  "'; rm -rf / #",
  "$(id)",
  "`id`",
  "line1\nline2\n'; echo pwned\n",
  "trailing newline\n",
  "\"double\" $HOME \\ backslash \\n",
  "'''",
  "* ? [a-z] ~",
  "héllo ✓ 🚀",
  "a;b|c&d>e<f",
  "${IFS}$((1+1))",
];

describe("buildPrelude", () => {
  it.each(HOSTILE)("passes %j to the script verbatim, without executing any of it", (value) => {
    const prelude = buildPrelude([def({ name: "X" })], { X: value }, { runId: 1, serverId: 2, hostname: "h.example.com" });
    // Exact equality also proves nothing else ran: an injected `echo`/`id` would
    // have added output before the value.
    expect(shellValue(prelude, "X")).toBe(value);
  });

  it("exports the run context, including a hostile hostname", () => {
    const prelude = buildPrelude([], {}, { runId: 42, serverId: 7, hostname: "$(id).example.com" });
    expect(shellValue(prelude, "RACKMAP_RUN_ID")).toBe("42");
    expect(shellValue(prelude, "RACKMAP_SERVER_ID")).toBe("7");
    expect(shellValue(prelude, "RACKMAP_HOSTNAME")).toBe("$(id).example.com");
  });

  it("never substitutes into the script body", () => {
    const script = 'echo "$X"\n';
    const full = composeRunbookScript(buildPrelude([def({ name: "X" })], { X: "$(id)" }, { runId: 1, serverId: 1, hostname: "h" }), script);
    expect(full.endsWith(script)).toBe(true);
    const out = execFileSync("/bin/sh", ["-c", `sh "$1"`, "sh", writeTmp(full)], { encoding: "utf8" });
    expect(out).toBe("$(id)\n");
  });

  it("reports the line offset of the script", () => {
    const prelude = buildPrelude([def({ name: "A" }), def({ name: "B" })], { A: "1", B: "2" }, { runId: 1, serverId: 1, hostname: "h" });
    const lines = prelude.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(`# ---- runbook script (line offset ${lines.length}) ----`);
  });

  it("revalidates values: NUL, pattern, unknown names and reserved names are refused", () => {
    const ctx = { runId: 1, serverId: 1, hostname: "h" };
    expect(() => buildPrelude([def({ name: "X" })], { X: "a\u0000b" }, ctx)).toThrow(RunbookParamError);
    expect(() => buildPrelude([def({ name: "X", pattern: "[a-z]+" })], { X: "abc;id" }, ctx)).toThrow(/format/);
    expect(() => buildPrelude([def({ name: "X" })], { Y: "1" }, ctx)).toThrow(/not defined/);
    // A definition that somehow bypassed the schema still cannot export PATH.
    const sneaky = { name: "PATH", type: "string", required: false } as RunbookParamDef;
    expect(() => buildPrelude([sneaky], { PATH: "/tmp/evil" }, ctx)).toThrow(/reserved/);
  });
});

function writeTmp(content: string): string {
  const file = path.join(dir, `script-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, content);
  return file;
}

describe("parameter names", () => {
  it.each(["PATH", "IFS", "BASH_ENV", "ENV", "PS4", "LD_PRELOAD", "BASH_FUNC_x", "SUDO_USER", "RACKMAP_RUN_ID", "PYTHONPATH", "PERL5LIB", "NODE_OPTIONS"])(
    "rejects reserved %s",
    (name) => {
      expect(runbookParamNameError(name)).not.toBeNull();
      expect(RunbookParamDef.safeParse({ name, type: "string" }).success).toBe(false);
    },
  );

  it.each(["lower", "1ABC", "A-B", "A B", "", "A".repeat(65)])("rejects malformed %j", (name) => {
    expect(runbookParamNameError(name)).not.toBeNull();
  });

  it.each(["VERSION", "TARGET_DIR", "X", "A1_B2"])("accepts %s", (name) => {
    expect(runbookParamNameError(name)).toBeNull();
  });
});

describe("parameter values", () => {
  it("matches patterns in full, not as a substring", () => {
    const d = def({ name: "V", pattern: "[0-9]+\\.[0-9]+" });
    expect(validateRunbookParamValue(d, "1.2").ok).toBe(true);
    expect(validateRunbookParamValue(d, "1.2; reboot").ok).toBe(false);
    expect(validateRunbookParamValue(d, "x1.2").ok).toBe(false);
    // Alternation is grouped: "a|b" must not become "^a|b$".
    const alt = def({ name: "W", pattern: "a|b" });
    expect(validateRunbookParamValue(alt, "a").ok).toBe(true);
    expect(validateRunbookParamValue(alt, "ab").ok).toBe(false);
    expect(validateRunbookParamValue(alt, "xa").ok).toBe(false);
  });

  it("rejects patterns that do not compile or are too long", () => {
    expect(RunbookParamDef.safeParse({ name: "P", type: "string", pattern: "(" }).success).toBe(false);
    expect(RunbookParamDef.safeParse({ name: "P", type: "string", pattern: "a".repeat(201) }).success).toBe(false);
  });

  it("normalises typed values and enforces enum and number formats", () => {
    expect(validateRunbookParamValue(def({ name: "B", type: "boolean" }), true)).toEqual({ ok: true, value: "true" });
    expect(validateRunbookParamValue(def({ name: "N", type: "number" }), 3)).toEqual({ ok: true, value: "3" });
    expect(validateRunbookParamValue(def({ name: "N", type: "number" }), "3; id").ok).toBe(false);
    const e = def({ name: "E", type: "enum", enumValues: ["blue", "green"] });
    expect(validateRunbookParamValue(e, "green").ok).toBe(true);
    expect(validateRunbookParamValue(e, "red").ok).toBe(false);
    expect(validateRunbookParamValue(def({ name: "S", maxLength: 3 }), "abcd").ok).toBe(false);
  });

  it("applies defaults, requires required values and refuses unknown names", () => {
    const defs = [def({ name: "A", default: "x" }), def({ name: "B", required: true })];
    expect(resolveRunbookParamValues(defs, { B: "y" })).toEqual({ values: { A: "x", B: "y" }, errors: {} });
    expect(resolveRunbookParamValues(defs, {}).errors).toEqual({ B: "is required" });
    expect(resolveRunbookParamValues(defs, { B: "y", PATH: "/x" }).errors).toHaveProperty("PATH");
  });

  it("refuses a default on a secret parameter", () => {
    expect(RunbookParamDef.safeParse({ name: "TOKEN", type: "secret", default: "x" }).success).toBe(false);
  });
});

describe("secret masking", () => {
  /** Feed `chunks` through a masker and return everything it emitted. */
  function feed(secrets: string[], chunks: string[]): string {
    const m = createSecretMasker(secrets);
    return chunks.map((c) => m.push(c)).join("") + m.flush();
  }

  it("masks a secret split across two chunks", () => {
    expect(feed(["hunter2"], ["password=hun", "ter2 ok"])).toBe("password=*** ok");
  });

  it("masks at every possible split point and with one character per chunk", () => {
    const text = "a hunter2 b hunter2hunter2 c";
    const expected = "a *** b ****** c";
    for (let i = 0; i <= text.length; i++) {
      expect(feed(["hunter2"], [text.slice(0, i), text.slice(i)])).toBe(expected);
    }
    expect(feed(["hunter2"], [...text])).toBe(expected);
  });

  it("prefers the longer secret when one is a prefix of another", () => {
    expect(feed(["abc", "abcdef"], ["x abcd", "ef y abc z"])).toBe("x *** y *** z");
    expect(feed(["abc", "abcdef"], [..."x abcdef y"])).not.toContain("def");
  });

  it("emits a secret held at the end of the stream on flush", () => {
    const m = createSecretMasker(["s3cr3t"]);
    const first = m.push("tail s3cr");
    expect(first).not.toContain("s3cr");
    expect(first + m.push("3t") + m.flush()).toBe("tail ***");
  });

  it("passes output through untouched when there are no secrets", () => {
    expect(feed([], ["abc", "def"])).toBe("abcdef");
    expect(feed([""], ["abc"])).toBe("abc");
  });
});

describe("runbook definition rules", () => {
  const base = {
    name: "rb",
    script: "echo hi",
    targetSelector: { serverIds: [1] },
  };

  it("refuses an empty target selector", () => {
    expect(RunbookCreateInput.safeParse({ ...base, targetSelector: {} }).success).toBe(false);
    expect(RunbookCreateInput.safeParse({ ...base, targetSelector: { excludeServerIds: [1], onlyUp: true } }).success).toBe(false);
    expect(RunbookCreateInput.safeParse(base).success).toBe(true);
  });

  it("refuses requireApproval together with a schedule", () => {
    const r = RunbookCreateInput.safeParse({ ...base, requireApproval: true, schedule: "0 3 * * *" });
    expect(r.success).toBe(false);
  });

  it("validates schedules in the vixie subset", () => {
    expect(runbookScheduleError("*/5 * * * *")).toBeNull();
    expect(runbookScheduleError("0 3 * * MON-FRI")).toBeNull();
    expect(runbookScheduleError("@daily")).toBeNull();
    expect(runbookScheduleError("@midnight")).toBeNull();
    expect(runbookScheduleError("@fortnightly")).not.toBeNull();
    expect(runbookScheduleError("@reboot")).not.toBeNull();
    expect(runbookScheduleError("0 0 L * *")).not.toBeNull();
    expect(runbookScheduleError("0 0 * * 5#2")).not.toBeNull();
    expect(runbookScheduleError("0 0 ? * *")).not.toBeNull();
    expect(runbookScheduleError("0 0 * * * *")).not.toBeNull();
    expect(runbookScheduleError("61 * * * *")).not.toBeNull();
  });

  it("refuses NUL bytes in the script", () => {
    expect(RunbookCreateInput.safeParse({ ...base, script: "echo\u0000hi" }).success).toBe(false);
  });
});

describe("parameter pattern ReDoS guard", () => {
  it.each(["(a+)+", "(\\w*)*", "(a|aa)+", "(?:ab+)*", "(x{1,})+", "(a)\\1"])("refuses %s", (pattern) => {
    expect(RunbookParamDef.safeParse({ name: "X", type: "string", pattern }).success).toBe(false);
  });

  it.each(["[a-z0-9-]+", "v\\d+\\.\\d+", "(prod|staging)", "[a-z]+(-[a-z]+)?", "\\(a+\\)+", "[(a+)]+"])(
    "accepts %s",
    (pattern) => {
      expect(RunbookParamDef.safeParse({ name: "X", type: "string", pattern }).success).toBe(true);
    },
  );
});
