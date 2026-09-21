import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../db.js";
import { createService, updateService } from "../modules/services/service.service.js";
import { decryptSecret } from "../lib/crypto.js";

/**
 * Regression guard: `updateService` destructured only `{ password, tagIds }`,
 * so a supplied `authToken` stayed in the rest object and reached Prisma as an
 * unknown field — the column is `authTokenEnc`. Updating a service's auth token
 * therefore threw, despite `ServiceUpdateInput` accepting one.
 */

const created: number[] = [];

/**
 * createService returns the client DTO, whose declared type deliberately omits
 * the encrypted columns — and, as a side effect of the narrowing, `id`. Widen
 * it here rather than weakening the production type.
 */
async function makeService(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const svc = (await createService(
    {
      serviceName: `authtoken-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      serverIp: "10.255.9.9",
      ...overrides,
    } as Parameters<typeof createService>[0],
    {},
  )) as unknown as Record<string, unknown>;
  created.push(svc["id"] as number);
  return svc;
}

afterAll(async () => {
  if (created.length > 0) {
    await prisma.serviceTag.deleteMany({ where: { serviceId: { in: created } } });
    await prisma.service.deleteMany({ where: { id: { in: created } } });
  }
});

describe("service auth token write path", () => {
  it("stores an auth token on create, encrypted", async () => {
    const svc = await makeService({ authToken: "created-token" });
    const row = await prisma.service.findUnique({ where: { id: svc["id"] as number } });

    expect(row?.authTokenEnc).toBeTruthy();
    expect(row?.authTokenEnc).not.toBe("created-token");
    expect(decryptSecret(row!.authTokenEnc!)).toBe("created-token");
  });

  it("updates an auth token instead of throwing", async () => {
    const svc = await makeService({ authToken: "original-token" });

    await expect(
      updateService(svc["id"] as number, { authToken: "rotated-token" } as Parameters<typeof updateService>[1], {}),
    ).resolves.toBeDefined();

    const row = await prisma.service.findUnique({ where: { id: svc["id"] as number } });
    expect(decryptSecret(row!.authTokenEnc!)).toBe("rotated-token");
  });

  it("clears an auth token when explicitly set to null", async () => {
    const svc = await makeService({ authToken: "to-be-cleared" });

    await updateService(svc["id"] as number, { authToken: null } as Parameters<typeof updateService>[1], {});

    const row = await prisma.service.findUnique({ where: { id: svc["id"] as number } });
    expect(row?.authTokenEnc).toBeNull();
  });

  it("leaves an existing auth token alone when the update does not mention it", async () => {
    const svc = await makeService({ authToken: "untouched-token" });

    await updateService(svc["id"] as number, { remark: "unrelated edit" } as Parameters<typeof updateService>[1], {});

    const row = await prisma.service.findUnique({ where: { id: svc["id"] as number } });
    expect(decryptSecret(row!.authTokenEnc!)).toBe("untouched-token");
  });

  it("never returns the encrypted token to callers, only a boolean", async () => {
    const svc = await makeService({ authToken: "secret-token" });
    expect(svc).not.toHaveProperty("authTokenEnc");
    expect(svc["hasAuthToken"]).toBe(true);
  });
});
