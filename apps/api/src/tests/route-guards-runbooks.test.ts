import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../app.js";
import { loginAs } from "./helpers.js";

/**
 * Every runbook route is guarded. Runbooks execute code across the fleet, so a
 * dropped `requirePermission` here is a remote-code-execution bug; these cases
 * fail the moment one goes missing. Viewers hold no runbook permission at all.
 */

const app = createApp();

let viewerCookie = "";
let editorCookie = "";

beforeAll(async () => {
  viewerCookie = await loginAs(app, "viewer");
  editorCookie = await loginAs(app, "editor");
});

type Case = { name: string; method: string; path: string; body?: unknown };

const EVERY_ROUTE: Case[] = [
  { name: "GET /runbooks", method: "GET", path: "/api/v1/runbooks" },
  { name: "POST /runbooks", method: "POST", path: "/api/v1/runbooks", body: { name: "x", script: "id", targetSelector: { serverIds: [1] } } },
  { name: "GET /runbooks/:id", method: "GET", path: "/api/v1/runbooks/1" },
  { name: "PATCH /runbooks/:id", method: "PATCH", path: "/api/v1/runbooks/1", body: { script: "id" } },
  { name: "DELETE /runbooks/:id", method: "DELETE", path: "/api/v1/runbooks/1" },
  { name: "POST /runbooks/:id/preview-targets", method: "POST", path: "/api/v1/runbooks/1/preview-targets", body: {} },
  { name: "POST /runbooks/:id/runs", method: "POST", path: "/api/v1/runbooks/1/runs", body: {} },
  { name: "GET /runbook-runs", method: "GET", path: "/api/v1/runbook-runs" },
  { name: "GET /runbook-runs/pending-count", method: "GET", path: "/api/v1/runbook-runs/pending-count" },
  { name: "GET /runbook-runs/:id", method: "GET", path: "/api/v1/runbook-runs/1" },
  { name: "GET /runbook-runs/:id/hosts/:serverId/output", method: "GET", path: "/api/v1/runbook-runs/1/hosts/1/output" },
  { name: "POST /runbook-runs/:id/approve", method: "POST", path: "/api/v1/runbook-runs/1/approve" },
  { name: "POST /runbook-runs/:id/reject", method: "POST", path: "/api/v1/runbook-runs/1/reject", body: {} },
  { name: "POST /runbook-runs/:id/cancel", method: "POST", path: "/api/v1/runbook-runs/1/cancel" },
  { name: "POST /runbook-runs/:id/rerun", method: "POST", path: "/api/v1/runbook-runs/1/rerun", body: {} },
];

/** Admin-only: authoring and the approval workflow. */
const EDITOR_MUST_NOT_REACH: Case[] = EVERY_ROUTE.filter((c) =>
  [
    "POST /runbooks",
    "PATCH /runbooks/:id",
    "DELETE /runbooks/:id",
    "GET /runbook-runs/pending-count",
    "POST /runbook-runs/:id/approve",
    "POST /runbook-runs/:id/reject",
  ].includes(c.name),
);

function request(c: Case, cookie?: string) {
  return app.request(c.path, {
    method: c.method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
}

describe("runbook route guards", () => {
  it.each(EVERY_ROUTE)("rejects an unauthenticated caller: $name", async (c) => {
    expect((await request(c)).status).toBe(401);
  });

  it.each(EVERY_ROUTE)("rejects a viewer: $name", async (c) => {
    expect((await request(c, viewerCookie)).status).toBe(403);
  });

  it.each(EDITOR_MUST_NOT_REACH)("rejects an editor: $name", async (c) => {
    expect((await request(c, editorCookie)).status).toBe(403);
  });

  it("a bogus API key is refused, not treated as anonymous", async () => {
    const res = await app.request("/api/v1/runbooks", { headers: { Authorization: "Bearer sk_bogus" } });
    expect(res.status).toBe(401);
  });
});
