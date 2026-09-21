import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../db.js";
import {
  INSTANCE_ID,
  acquireJobLock,
  releaseJobLock,
  renewJobLock,
  withJobLock,
} from "../services/job-lock.service.js";

const JOB = "test:job";
const TTL = 60_000;
/** Stands in for a second API replica. */
const REPLICA_B = "other-host:4242:deadbeef";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plant a lease directly, bypassing acquire, so a test can pick its own expiry. */
async function seedLock(holder: string, expiresAt: Date) {
  const now = new Date();
  await prisma.schedulerLock.create({
    data: { name: JOB, holder, acquiredAt: now, heartbeatAt: now, expiresAt },
  });
}

async function readLock() {
  return prisma.schedulerLock.findUnique({ where: { name: JOB } });
}

describe("job-lock.service", () => {
  beforeEach(async () => {
    await prisma.schedulerLock.deleteMany();
  });

  describe("acquireJobLock", () => {
    it("creates the row on the very first acquisition", async () => {
      const before = Date.now();
      expect(await acquireJobLock(JOB, TTL)).toBe(true);

      const row = await readLock();
      expect(row).not.toBeNull();
      expect(row!.holder).toBe(INSTANCE_ID);
      expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TTL);
    });

    it("refuses a lease another holder is still holding", async () => {
      await seedLock(REPLICA_B, new Date(Date.now() + TTL));
      expect(await acquireJobLock(JOB, TTL)).toBe(false);

      // And did not trample the incumbent's row.
      expect((await readLock())!.holder).toBe(REPLICA_B);
    });

    it("refuses re-entry even to the current holder", async () => {
      expect(await acquireJobLock(JOB, TTL)).toBe(true);
      expect(await acquireJobLock(JOB, TTL)).toBe(false);
    });

    it("lets another holder take an expired lease", async () => {
      await seedLock(REPLICA_B, new Date(Date.now() - 1));

      expect(await acquireJobLock(JOB, TTL)).toBe(true);
      const row = await readLock();
      expect(row!.holder).toBe(INSTANCE_ID);
      expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("recovers a lease whose holder was killed mid-job", async () => {
      // A process killed outright never releases: its row simply stops being
      // renewed, and the last heartbeat + TTL is already in the past.
      await seedLock("crashed-instance:1:00000000", new Date(Date.now() - TTL));

      const ran = vi.fn(async () => "took over");
      const outcome = await withJobLock(JOB, TTL, ran);

      expect(outcome).toEqual({ acquired: true, result: "took over" });
      expect(ran).toHaveBeenCalledOnce();
    });

    it("gives the lease to exactly one of two racing replicas (no row yet)", async () => {
      const results = await Promise.all([
        acquireJobLock(JOB, TTL, INSTANCE_ID),
        acquireJobLock(JOB, TTL, REPLICA_B),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      const row = await readLock();
      // Whoever won, the row names exactly one of them.
      expect([INSTANCE_ID, REPLICA_B]).toContain(row!.holder);
    });

    it("gives the lease to exactly one of two racing replicas (expired row)", async () => {
      await seedLock("previous-holder:9:99999999", new Date(Date.now() - 1));

      const results = await Promise.all([
        acquireJobLock(JOB, TTL, INSTANCE_ID),
        acquireJobLock(JOB, TTL, REPLICA_B),
      ]);

      const winners = [INSTANCE_ID, REPLICA_B].filter((_, i) => results[i]);
      expect(winners).toHaveLength(1);
      expect((await readLock())!.holder).toBe(winners[0]);
    });
  });

  describe("withJobLock", () => {
    it("runs the body and releases the lease afterwards", async () => {
      const outcome = await withJobLock(JOB, TTL, async () => 42);
      expect(outcome).toEqual({ acquired: true, result: 42 });

      // Released, so the next replica along can take it immediately.
      expect((await readLock())!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await acquireJobLock(JOB, TTL, REPLICA_B)).toBe(true);
    });

    it("skips quietly when another replica holds the lease", async () => {
      await seedLock(REPLICA_B, new Date(Date.now() + TTL));

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const body = vi.fn(async () => "should not run");
      let outcome;
      try {
        // Losing the race is the normal state for every replica but one: it must
        // neither throw nor log, or a 60s loop would produce 1,440 lines a day.
        outcome = await withJobLock(JOB, TTL, body);
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }

      expect(outcome).toEqual({ acquired: false });
      expect(body).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      // The incumbent's lease is untouched.
      expect((await readLock())!.holder).toBe(REPLICA_B);
    });

    it("releases the lease when the body throws, and rethrows", async () => {
      const boom = new Error("job exploded");
      await expect(withJobLock(JOB, TTL, async () => { throw boom; })).rejects.toThrow("job exploded");

      // Freed immediately rather than blocking the next tick for a whole TTL.
      expect(await acquireJobLock(JOB, TTL, REPLICA_B)).toBe(true);
    });

    it("runs only one of two concurrent callers", async () => {
      const calls: string[] = [];
      const body = (who: string) => async () => {
        calls.push(who);
        await sleep(50);
      };

      const [a, b] = await Promise.all([
        withJobLock(JOB, TTL, body("a"), { holder: INSTANCE_ID }),
        withJobLock(JOB, TTL, body("b"), { holder: REPLICA_B }),
      ]);

      expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
      expect(calls).toHaveLength(1);
    });

    it("keeps the lease alive across a run longer than the TTL", async () => {
      // TTL 3s → heartbeat every 1s. The body outlives one heartbeat, so if the
      // lease were never renewed it would be takeable before the body returned.
      const shortTtl = 3_000;
      let expiryAtStart = 0;

      const outcome = await withJobLock(
        JOB,
        shortTtl,
        async () => {
          expiryAtStart = (await readLock())!.expiresAt.getTime();
          await sleep(1_400);
        },
        // Skip the release so the assertions see the renewed expiry, not the
        // released one.
        { holdUntilExpiry: true },
      );

      expect(outcome.acquired).toBe(true);
      const row = await readLock();
      expect(row!.expiresAt.getTime()).toBeGreaterThan(expiryAtStart);
      expect(row!.heartbeatAt.getTime()).toBeGreaterThan(row!.acquiredAt.getTime());
      // Still ours, still live — a second replica cannot start the same job.
      expect(await acquireJobLock(JOB, shortTtl, REPLICA_B)).toBe(false);
    });
  });

  describe("renewJobLock", () => {
    it("pushes the expiry out for the current holder", async () => {
      await acquireJobLock(JOB, TTL);
      const before = (await readLock())!.expiresAt.getTime();

      expect(await renewJobLock(JOB, TTL * 2)).toBe(true);
      expect((await readLock())!.expiresAt.getTime()).toBeGreaterThan(before);
    });

    it("refuses to renew a lease held by someone else", async () => {
      await seedLock(REPLICA_B, new Date(Date.now() + TTL));
      expect(await renewJobLock(JOB, TTL)).toBe(false);
    });

    it("refuses to renew a lease that already expired", async () => {
      // A stalled process must not be able to reclaim a lease another replica
      // may already have taken.
      await seedLock(INSTANCE_ID, new Date(Date.now() - 1));
      expect(await renewJobLock(JOB, TTL)).toBe(false);
    });

    it("reports false for a job that has never been locked", async () => {
      expect(await renewJobLock("test:never", TTL)).toBe(false);
    });
  });

  describe("releaseJobLock", () => {
    it("expires our own lease in place, keeping the row for inspection", async () => {
      await acquireJobLock(JOB, TTL);
      await releaseJobLock(JOB);

      const row = await readLock();
      expect(row).not.toBeNull();
      expect(row!.holder).toBe(INSTANCE_ID);
      expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("cannot release a lease another holder owns", async () => {
      await seedLock(REPLICA_B, new Date(Date.now() + TTL));
      await releaseJobLock(JOB);

      const row = await readLock();
      expect(row!.holder).toBe(REPLICA_B);
      expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });
});

describe("job-lock instance identity", () => {
  it("is a stable per-process id naming host and pid", () => {
    expect(INSTANCE_ID).toContain(`:${process.pid}:`);
    expect(INSTANCE_ID).toBe(INSTANCE_ID);
  });
});
