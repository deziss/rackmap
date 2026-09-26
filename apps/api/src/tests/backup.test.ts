import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Postgres backups (B4). pg_dump is replaced with a fake that records how it
 * was invoked and writes its --file, so these run without a PostgreSQL client.
 * Everything else — the real module under test, the real filesystem — is live.
 */

type Call = { file: string; args: string[]; env: NodeJS.ProcessEnv };
const calls: Call[] = [];
let behaviour: "ok" | "fail" | "enoent" = "ok";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      opts: { env: NodeJS.ProcessEnv },
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ file, args, env: opts.env });
      if (behaviour === "enoent") {
        const err = Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT", path: file });
        setImmediate(() => cb(err, "", ""));
        return;
      }
      if (behaviour === "fail") {
        const err = Object.assign(new Error("Command failed: pg_dump"), { code: 1 });
        setImmediate(() => cb(err, "", 'pg_dump: error: connection to server failed: FATAL: role "x" does not exist'));
        return;
      }
      const out = args.find((a) => a.startsWith("--file="))?.slice("--file=".length);
      if (out) writeFileSync(out, "PGDMP fake custom-format archive");
      setImmediate(() => cb(null, "", ""));
    },
  };
});

const { env } = await import("../env.js");
const { runBackup, rotateBackups, pgConnectionFromUrl, getBackupHealth } = await import(
  "../services/backup.service.js"
);

const PASSWORD = "s3cr:t/p@ss?word";
const ENCODED = encodeURIComponent(PASSWORD);
const FAKE_URL = `postgresql://rackmap_app:${ENCODED}@db.example.com:6543/rackmap_prod?schema=inventory&sslmode=require&connection_limit=5`;

const saved = { url: env.DATABASE_URL, dir: env.BACKUP_DIR, keep: env.BACKUP_KEEP };
let dir = "";

beforeEach(() => {
  calls.length = 0;
  behaviour = "ok";
  dir = mkdtempSync(join(tmpdir(), "rackmap-backup-test-"));
  env.DATABASE_URL = FAKE_URL;
  env.BACKUP_DIR = dir;
  env.BACKUP_KEEP = 3;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  env.DATABASE_URL = saved.url;
  env.BACKUP_DIR = saved.dir;
  env.BACKUP_KEEP = saved.keep;
});

const dumps = () => readdirSync(dir).filter((f) => f.endsWith(".dump")).sort();

describe("runBackup — pg_dump invocation", () => {
  it("never puts the password in argv, and passes it only as PGPASSWORD", async () => {
    const result = await runBackup();
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe("pg_dump");
    const argv = call.args.join(" ");
    expect(argv).not.toContain(PASSWORD);
    expect(argv).not.toContain(ENCODED);
    expect(argv).not.toContain("postgresql://");
    expect(call.args).toContain("--format=custom");
    expect(call.args).toContain("--no-password");
    expect(call.args).toContain('--schema="inventory"');

    expect(call.env.PGPASSWORD).toBe(PASSWORD);
    expect(call.env.PGHOST).toBe("db.example.com");
    expect(call.env.PGPORT).toBe("6543");
    expect(call.env.PGUSER).toBe("rackmap_app");
    expect(call.env.PGDATABASE).toBe("rackmap_prod");
    expect(call.env.PGSSLMODE).toBe("require");
  });

  it("does not hand the API's own secrets to the child process", async () => {
    await runBackup();
    const childEnv = calls[0]!.env;
    for (const key of ["DATABASE_URL", "BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "VAULT_PASSPHRASE"]) {
      expect(childEnv[key], key).toBeUndefined();
    }
    expect(childEnv.PATH).toBeTruthy();
  });

  it("writes rackmap-<ISO>.dump with owner-only permissions and no leftover partial file", async () => {
    const result = await runBackup();
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^rackmap-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.dump$/);
    expect(result.file).toBe(join(dir, files[0]!));
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    expect(getBackupHealth().lastError).toBeNull();
  });

  it("omits --schema when the URL has none", async () => {
    env.DATABASE_URL = `postgresql://rackmap_app:${ENCODED}@db.example.com/rackmap_prod`;
    await runBackup();
    expect(calls[0]!.args.some((a) => a.startsWith("--schema"))).toBe(false);
    expect(calls[0]!.env.PGPORT).toBe("5432");
  });
});

describe("runBackup — rotation", () => {
  const seed = (names: string[]) => names.forEach((n) => writeFileSync(join(dir, n), "old"));

  it("keeps the BACKUP_KEEP newest dumps and never touches other files", async () => {
    seed([
      "rackmap-2020-01-01T02-00-00-000Z.dump",
      "rackmap-2020-01-02T02-00-00-000Z.dump",
      "rackmap-2020-01-03T02-00-00-000Z.dump",
      "rackmap-2020-01-04T02-00-00-000Z.dump",
      "inventory-2020-01-01T00-00-00.db", // legacy SQLite copy
      "notes.txt",
    ]);

    await runBackup();

    const kept = dumps();
    expect(kept).toHaveLength(3);
    expect(kept).toContain("rackmap-2020-01-03T02-00-00-000Z.dump");
    expect(kept).toContain("rackmap-2020-01-04T02-00-00-000Z.dump");
    expect(kept.some((f) => f.startsWith(`rackmap-${new Date().getUTCFullYear()}`))).toBe(true);
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(["inventory-2020-01-01T00-00-00.db", "notes.txt"]));
  });

  it("rotateBackups keeps exactly N newest", async () => {
    seed([
      "rackmap-2021-05-01T00-00-00-000Z.dump",
      "rackmap-2021-05-03T00-00-00-000Z.dump",
      "rackmap-2021-05-02T00-00-00-000Z.dump",
    ]);
    const removed = await rotateBackups(dir, 1);
    expect(removed.sort()).toEqual(["rackmap-2021-05-01T00-00-00-000Z.dump", "rackmap-2021-05-02T00-00-00-000Z.dump"]);
    expect(dumps()).toEqual(["rackmap-2021-05-03T00-00-00-000Z.dump"]);
  });

  it("a failed dump deletes nothing, leaves no partial file and is reported", async () => {
    seed([
      "rackmap-2020-01-01T02-00-00-000Z.dump",
      "rackmap-2020-01-02T02-00-00-000Z.dump",
      "rackmap-2020-01-03T02-00-00-000Z.dump",
      "rackmap-2020-01-04T02-00-00-000Z.dump",
    ]);
    behaviour = "fail";

    const result = await runBackup();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
    expect(readdirSync(dir).sort()).toEqual(dumps()); // no .partial left behind
    expect(dumps()).toHaveLength(4);
    expect(getBackupHealth().lastError).toContain("does not exist");
  });

  it("reports a missing pg_dump distinctly", async () => {
    behaviour = "enoent";
    const result = await runBackup();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pg_dump not found/);
    expect(getBackupHealth().pgDump).toBe("missing");
  });
});

describe("pgConnectionFromUrl", () => {
  it("decodes credentials and honours a ?host= socket directory", () => {
    const conn = pgConnectionFromUrl(`postgres://u%40x:${ENCODED}@localhost/db?host=/run/postgresql`);
    expect(conn.env.PGHOST).toBe("/run/postgresql");
    expect(conn.env.PGUSER).toBe("u@x");
    expect(conn.env.PGPASSWORD).toBe(PASSWORD);
    expect(conn.schema).toBeNull();
  });

  it("rejects a non-postgres URL", () => {
    expect(() => pgConnectionFromUrl("file:/data/inventory.db")).toThrow(/postgresql/);
  });
});
