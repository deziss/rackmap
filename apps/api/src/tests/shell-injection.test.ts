import { describe, it, expect } from "vitest";
import {
  AtopQueryInput,
  AtopTopProcessesInput,
  AtopIntervalProcessesInput,
  CreateOsUserInput,
  UpdateOsUserInput,
  SudoPermissionInput,
} from "@inv/shared";
import { escapeShellArg } from "../services/shell-escape.js";

/**
 * Regression guard for the v0.6.1 command-injection fixes.
 *
 * Every field asserted here is interpolated into a shell command that runs on a
 * managed host, frequently under sudo. Before v0.6.1 they were bare strings.
 */

/** Payloads that must never survive validation on a shell-bound field. */
const HOSTILE = [
  "x; id > /tmp/pwned",
  "x && touch /tmp/pwned",
  "x | tee /tmp/pwned",
  "$(touch /tmp/pwned)",
  "`touch /tmp/pwned`",
  "x\ntouch /tmp/pwned",
  "x' ; touch /tmp/pwned ; '",
  "../../etc/passwd",
];

describe("atop time fields reject shell metacharacters", () => {
  it.each(HOSTILE)("AtopQueryInput rejects timeFrom %j", (payload) => {
    expect(AtopQueryInput.safeParse({ timeFrom: payload }).success).toBe(false);
  });

  it.each(HOSTILE)("AtopQueryInput rejects timeTo %j", (payload) => {
    expect(AtopQueryInput.safeParse({ timeTo: payload }).success).toBe(false);
  });

  it.each(HOSTILE)("AtopTopProcessesInput rejects time %j", (payload) => {
    expect(AtopTopProcessesInput.safeParse({ date: "20260921", time: payload }).success).toBe(false);
  });

  it.each(HOSTILE)("AtopIntervalProcessesInput rejects time %j", (payload) => {
    expect(AtopIntervalProcessesInput.safeParse({ date: "20260921", time: payload }).success).toBe(false);
  });

  it.each(["09:30", "9:30", "23:59:59", "00:00"])("still accepts the real format %s", (good) => {
    expect(AtopQueryInput.safeParse({ timeFrom: good }).success).toBe(true);
    expect(AtopIntervalProcessesInput.safeParse({ date: "20260921", time: good }).success).toBe(true);
  });

  it("requires a time on the interval-processes input", () => {
    expect(AtopIntervalProcessesInput.safeParse({ date: "20260921" }).success).toBe(false);
  });
});

describe("OS user fields reject shell metacharacters", () => {
  const base = { username: "alice" };

  it("accepts the baseline object, so rejections below are attributable", () => {
    expect(CreateOsUserInput.safeParse(base).success).toBe(true);
  });

  it.each(HOSTILE)("rejects shell %j", (payload) => {
    expect(CreateOsUserInput.safeParse({ ...base, shell: payload }).success).toBe(false);
    expect(UpdateOsUserInput.safeParse({ shell: payload }).success).toBe(false);
  });

  it.each(HOSTILE)("rejects homeDir %j", (payload) => {
    expect(CreateOsUserInput.safeParse({ ...base, homeDir: payload }).success).toBe(false);
  });

  it.each(HOSTILE)("rejects a group name %j", (payload) => {
    expect(CreateOsUserInput.safeParse({ ...base, groups: [payload] }).success).toBe(false);
  });

  it("still accepts ordinary values", () => {
    const ok = CreateOsUserInput.safeParse({
      ...base,
      shell: "/bin/bash",
      homeDir: "/home/alice",
      groups: ["sudo", "docker"],
    });
    expect(ok.success).toBe(true);
  });
});

describe("sudoers command entries are allowlisted", () => {
  // username and permissionType are required; supplying them keeps every
  // assertion below attributable to the command pattern itself rather than to
  // a missing field.
  const sudoBase = { username: "alice", permissionType: "custom" as const };

  it("accepts the baseline object, so rejections below are attributable", () => {
    expect(
      SudoPermissionInput.safeParse({ ...sudoBase, customCommands: ["/usr/bin/passwd"] }).success,
    ).toBe(true);
  });

  it.each(HOSTILE)("rejects %j", (payload) => {
    expect(SudoPermissionInput.safeParse({ ...sudoBase, customCommands: [payload] }).success).toBe(false);
  });

  // Not shell injection, but a rule-restructuring / privilege-escalation primitive:
  // these would rewrite the generated /etc/sudoers.d entry into a broader grant.
  it.each(["ALL", "NOPASSWD: ALL", "/bin/sh, ALL", "ALL=(ALL:ALL) NOPASSWD: ALL", "/usr/bin/*"])(
    "rejects the sudoers escape %j",
    (payload) => {
      expect(SudoPermissionInput.safeParse({ ...sudoBase, customCommands: [payload] }).success).toBe(false);
    },
  );

  it("still accepts explicit absolute command paths with plain arguments", () => {
    const ok = SudoPermissionInput.safeParse({
      ...sudoBase,
      customCommands: ["/usr/bin/systemctl restart nginx", "/usr/bin/passwd", "/bin/journalctl -u sshd"],
    });
    expect(ok.success).toBe(true);
  });
});

describe("escapeShellArg", () => {
  it("wraps a value so a shell reads it as one literal argument", () => {
    expect(escapeShellArg("plain")).toBe("'plain'");
  });

  it("neutralises an embedded single quote rather than letting it close the quoting", () => {
    // The only sequence a POSIX shell cannot re-enter: close, escape, reopen.
    expect(escapeShellArg("a'b")).toBe("'a'\\''b'");
  });

  it.each(HOSTILE)("leaves no unquoted metacharacter for %j", (payload) => {
    const escaped = escapeShellArg(payload);
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
    // Every inner single quote must be part of the '\'' escape sequence.
    expect(escaped.slice(1, -1).replace(/'\\''/g, "")).not.toContain("'");
  });
});
