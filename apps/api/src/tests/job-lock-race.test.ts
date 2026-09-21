import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../db.js";
import { acquireJobLock, releaseJobLock } from "../services/job-lock.service.js";

/**
 * High-concurrency adversarial check on the lease.
 *
 * A lock that is merely *usually* exclusive is worse than no lock: it would let
 * two replicas double-probe the fleet and double-fire notifications only
 * occasionally, which is far harder to diagnose than a consistent failure. The
 * companion suite proves the two-replica case; this one leans on it hard enough
 * that a read-then-write race would actually show up.
 */

const NAME = "race:concurrency-check";
const CONTENDERS = 25;

beforeEach(async () => {
  await prisma.schedulerLock.deleteMany({ where: { name: NAME } });
});

afterAll(async () => {
  await prisma.schedulerLock.deleteMany({ where: { name: NAME } });
});

function stampede(prefix: string) {
  return Promise.all(
    Array.from({ length: CONTENDERS }, (_, i) => acquireJobLock(NAME, 60_000, `${prefix}-${i}`)),
  );
}

describe("job lock under concurrency", () => {
  it("elects exactly one winner when no row exists yet (INSERT race)", async () => {
    const results = await stampede("cold");
    expect(results.filter(Boolean)).toHaveLength(1);

    const row = await prisma.schedulerLock.findUnique({ where: { name: NAME } });
    expect(row?.holder).toMatch(/^cold-\d+$/);
  });

  it("refuses every contender while a lease is live", async () => {
    expect(await acquireJobLock(NAME, 60_000, "incumbent")).toBe(true);

    const results = await stampede("challenger");
    expect(results.filter(Boolean)).toHaveLength(0);

    // The incumbent must still hold it — a loser must not have stolen or reset it.
    const row = await prisma.schedulerLock.findUnique({ where: { name: NAME } });
    expect(row?.holder).toBe("incumbent");
  });

  it("elects exactly one winner when the lease has expired (UPDATE race)", async () => {
    await acquireJobLock(NAME, 60_000, "dead-holder");
    await prisma.schedulerLock.update({
      where: { name: NAME },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const results = await stampede("taker");
    expect(results.filter(Boolean)).toHaveLength(1);

    const row = await prisma.schedulerLock.findUnique({ where: { name: NAME } });
    expect(row?.holder).toMatch(/^taker-\d+$/);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("never lets a non-holder release the lease", async () => {
    await acquireJobLock(NAME, 60_000, "incumbent");
    const before = await prisma.schedulerLock.findUnique({ where: { name: NAME } });

    await Promise.all(
      Array.from({ length: CONTENDERS }, (_, i) => releaseJobLock(NAME, `impostor-${i}`)),
    );

    const after = await prisma.schedulerLock.findUnique({ where: { name: NAME } });
    expect(after?.holder).toBe("incumbent");
    expect(after?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());
  });

  it("hands the lease on cleanly after the holder releases it", async () => {
    await acquireJobLock(NAME, 60_000, "first");
    await releaseJobLock(NAME, "first");

    const results = await stampede("second-wave");
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
