import { describe, it, expect } from "vitest";
import { DeleteOsUserInput, CreateOsUserInput, UpdateOsUserInput } from "@inv/shared";
import { grantsPrivilegedAccess, PRIVILEGED_OS_GROUPS } from "../services/os-user.service.js";

/**
 * DELETE /servers/:id/os-users/:username validates its QUERY STRING with
 * DeleteOsUserInput, so the booleans arrive as "true" / "false". A plain
 * z.boolean() rejected every request (the reported repeated 400s); a
 * z.coerce.boolean() would turn "false" into true and run `userdel -f`.
 */
describe("DeleteOsUserInput parses query-string booleans", () => {
  it('"false" is false, not true', () => {
    const parsed = DeleteOsUserInput.parse({ removeHome: "false", force: "false" });
    expect(parsed).toEqual({ removeHome: false, force: false });
  });

  it('"true" is true', () => {
    expect(DeleteOsUserInput.parse({ removeHome: "true", force: "true" })).toEqual({ removeHome: true, force: true });
  });

  it("missing stays undefined (the service default applies)", () => {
    const parsed = DeleteOsUserInput.parse({});
    expect(parsed.removeHome).toBeUndefined();
    expect(parsed.force).toBeUndefined();
  });

  it("still accepts real booleans from JSON callers", () => {
    expect(DeleteOsUserInput.parse({ removeHome: true, force: false })).toEqual({ removeHome: true, force: false });
  });

  it.each(["1", "yes", "TRUE", ""])("any other string (%j) is false — never an accidental force", (v) => {
    expect(DeleteOsUserInput.parse({ force: v }).force).toBe(false);
  });

  it("the exact query from the screenshot parses", () => {
    const query = Object.fromEntries(new URLSearchParams("removeHome=true&force=false"));
    expect(DeleteOsUserInput.parse(query)).toEqual({ removeHome: true, force: false });
  });
});

describe("OS account passwords cannot inject chpasswd lines", () => {
  it.each(["a\nroot:pwned", "a\rb", "a\u0000b"])("rejects %j", (pw) => {
    expect(CreateOsUserInput.safeParse({ username: "alice", password: pw }).success).toBe(false);
    expect(UpdateOsUserInput.safeParse({ password: pw }).success).toBe(false);
  });

  it("accepts ordinary passwords, including ':' and quotes", () => {
    expect(CreateOsUserInput.safeParse({ username: "alice", password: "p:a's$w\"rd" }).success).toBe(true);
  });
});

describe("grantsPrivilegedAccess", () => {
  it.each(["all_nopasswd", "all_passwd", "custom"])("a %s sudo grant is privileged", (sudoType) => {
    expect(grantsPrivilegedAccess({ sudoType })).toBe(true);
  });

  it.each([...PRIVILEGED_OS_GROUPS, "Docker", " sudo "])("group %j is privileged", (g) => {
    expect(grantsPrivilegedAccess({ groups: ["developers", g] })).toBe(true);
  });

  it("plain accounts are not", () => {
    expect(grantsPrivilegedAccess({})).toBe(false);
    expect(grantsPrivilegedAccess({ sudoType: "none", groups: ["developers", "www-data"] })).toBe(false);
  });
});
