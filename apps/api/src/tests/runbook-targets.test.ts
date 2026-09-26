import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RunbookTargetSelector } from "@inv/shared";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import {
  everyTargetNeedsLockedVault,
  narrowTargets,
  resolveTargets,
  targetWarnings,
} from "../services/runbook-targets.js";

/**
 * Target resolution decides which machines a script touches. The dangerous
 * failure is a selector that silently widens — an empty form meaning "all
 * servers", or AND/OR swapped — so the semantics are pinned here.
 */

const sel = (s: Partial<RunbookTargetSelector>) => RunbookTargetSelector.parse(s);

const ids: Record<string, number> = {};
let tagA = 0;
let tagB = 0;
let locX = 0;

beforeAll(async () => {
  tagA = (await prisma.tag.create({ data: { name: "rbt-tag-a" } })).id;
  tagB = (await prisma.tag.create({ data: { name: "rbt-tag-b" } })).id;
  locX = (await prisma.location.create({ data: { name: "rbt-loc-x" } })).id;

  const mk = async (key: string, data: { environment?: string; locationId?: number; tags?: number[]; deleted?: boolean; lastStatus?: string }) => {
    const s = await prisma.server.create({
      data: {
        hostname: `rbt-${key}.example.com`,
        ip: `192.0.2.${10 + Object.keys(ids).length}`,
        username: "ops",
        environment: data.environment ?? "on-premise",
        locationId: data.locationId ?? null,
        lastStatus: data.lastStatus ?? "up",
        deletedAt: data.deleted ? new Date() : null,
        tags: data.tags ? { create: data.tags.map((tagId) => ({ tagId })) } : undefined,
      },
    });
    ids[key] = s.id;
  };

  await mk("a-cloud", { tags: [tagA], environment: "cloud" });
  await mk("a-onprem", { tags: [tagA], environment: "on-premise", locationId: locX });
  await mk("b-cloud", { tags: [tagB], environment: "cloud", lastStatus: "down" });
  await mk("ab-cloud", { tags: [tagA, tagB], environment: "cloud", locationId: locX });
  await mk("none", {});
  await mk("deleted", { tags: [tagA], environment: "cloud", deleted: true });
});

afterAll(async () => {
  await prisma.server.deleteMany({ where: { hostname: { startsWith: "rbt-" } } });
  await prisma.tag.deleteMany({ where: { name: { startsWith: "rbt-" } } });
  await prisma.location.deleteMany({ where: { name: { startsWith: "rbt-" } } });
});

async function hostnames(s: Partial<RunbookTargetSelector>, opts?: { maxTargets?: number }) {
  const r = await resolveTargets(sel(s), opts);
  return r.servers.map((x) => x.hostname.replace(/^rbt-|\.example\.com$/g, "")).sort();
}

describe("resolveTargets", () => {
  it("refuses an empty selector instead of matching every server", async () => {
    await expect(resolveTargets(sel({}))).rejects.toBeInstanceOf(AppError);
    await expect(resolveTargets(sel({ excludeServerIds: [ids["none"]!], onlyUp: true }))).rejects.toMatchObject({ status: 400 });
  });

  it("ORs values within one dimension", async () => {
    expect(await hostnames({ tagIds: [tagA, tagB] })).toEqual(["a-cloud", "a-onprem", "ab-cloud", "b-cloud"]);
  });

  it("ANDs across dimensions", async () => {
    expect(await hostnames({ tagIds: [tagA], environments: ["cloud"] })).toEqual(["a-cloud", "ab-cloud"]);
    expect(await hostnames({ tagIds: [tagA], environments: ["cloud"], locationIds: [locX] })).toEqual(["ab-cloud"]);
  });

  it("unions explicit servers with the filter set, then subtracts exclusions", async () => {
    expect(await hostnames({ serverIds: [ids["none"]!], tagIds: [tagB] })).toEqual(["ab-cloud", "b-cloud", "none"]);
    expect(await hostnames({ serverIds: [ids["none"]!], tagIds: [tagB], excludeServerIds: [ids["b-cloud"]!] })).toEqual(["ab-cloud", "none"]);
  });

  it("never includes soft-deleted servers, even when named explicitly", async () => {
    expect(await hostnames({ serverIds: [ids["deleted"]!, ids["none"]!] })).toEqual(["none"]);
    expect(await hostnames({ tagIds: [tagA] })).not.toContain("deleted");
  });

  it("onlyUp drops servers that are down", async () => {
    expect(await hostnames({ tagIds: [tagB], onlyUp: true })).toEqual(["ab-cloud"]);
  });

  it("caps the result and reports that it did", async () => {
    const r = await resolveTargets(sel({ tagIds: [tagA, tagB] }), { maxTargets: 2 });
    expect(r.servers).toHaveLength(2);
    expect(r.exceeded).toBe(true);
    const r2 = await resolveTargets(sel({ tagIds: [tagA, tagB] }), { maxTargets: 4 });
    expect(r2.exceeded).toBe(false);
  });
});

describe("narrowTargets", () => {
  const resolved = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("keeps a subset", () => {
    expect(narrowTargets(resolved, [3, 1]).map((s) => s.id)).toEqual([1, 3]);
    expect(narrowTargets(resolved, undefined)).toBe(resolved);
  });

  it("refuses to widen", () => {
    expect(() => narrowTargets(resolved, [1, 99])).toThrow(/only narrow/);
  });
});

describe("preview warnings", () => {
  it("flags down, vault-locked and credential-less hosts", () => {
    const locked = { vaultUnlocked: false, keyAvailable: false };
    expect(targetWarnings({ lastStatus: "down", passwordEnc: "v3.x" }, locked)).toEqual(["down"]);
    expect(targetWarnings({ lastStatus: "up", passwordEnc: "v2.abc" }, locked)).toEqual(["vault_required"]);
    expect(targetWarnings({ lastStatus: "up", passwordEnc: "v2.abc" }, { ...locked, vaultUnlocked: true })).toEqual([]);
    expect(targetWarnings({ lastStatus: "up", passwordEnc: null }, locked)).toEqual(["no_credentials"]);
    expect(targetWarnings({ lastStatus: "up", passwordEnc: null }, { ...locked, keyAvailable: true })).toEqual([]);
  });

  it("only blocks a run when no target could work without the vault", () => {
    const vaulted = { id: 1, hostname: "h", ip: "192.0.2.1", environment: null, lastStatus: "up", passwordEnc: "v2.x" };
    const plain = { ...vaulted, id: 2, passwordEnc: "v3.x" };
    const opts = { vaultUnlocked: false, keyAvailable: true };
    // Key auth still works for a non-root run...
    expect(everyTargetNeedsLockedVault([vaulted], { ...opts, asRoot: false })).toBe(false);
    // ...but sudo needs the password.
    expect(everyTargetNeedsLockedVault([vaulted], { ...opts, asRoot: true })).toBe(true);
    expect(everyTargetNeedsLockedVault([vaulted], { ...opts, asRoot: false, keyAvailable: false })).toBe(true);
    expect(everyTargetNeedsLockedVault([vaulted, plain], { ...opts, asRoot: true })).toBe(false);
    expect(everyTargetNeedsLockedVault([vaulted], { ...opts, asRoot: true, vaultUnlocked: true })).toBe(false);
  });
});
