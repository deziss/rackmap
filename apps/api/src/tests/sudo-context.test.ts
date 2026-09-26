import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { withSudoOverride, currentSudoPasswordOverride } from "../lib/sudo-context.js";

const app = new Hono().use(withSudoOverride).get("/", (c) => c.json({ pw: currentSudoPasswordOverride() ?? null }));

async function seen(headers: Record<string, string>) {
  const res = await app.request("/", { headers });
  return ((await res.json()) as { pw: string | null }).pw;
}

describe("X-Sudo-Password override", () => {
  it("is scoped to the request that sent it", async () => {
    expect(await seen({ "X-Sudo-Password": "s3cret pass" })).toBe("s3cret pass");
    expect(await seen({})).toBeNull();
    expect(currentSudoPasswordOverride()).toBeUndefined();
  });

  it("ignores values that could feed extra lines to sudo -S", async () => {
    // fetch() itself rejects CR/LF in header values, so build the header on the raw request.
    const raw = new Request("http://x/", { headers: { "X-Sudo-Password": "ok" } });
    expect(await seen({ "X-Sudo-Password": "a".repeat(1025) })).toBeNull();
    expect((await (await app.fetch(raw)).json()) as { pw: string }).toEqual({ pw: "ok" });
  });
});
