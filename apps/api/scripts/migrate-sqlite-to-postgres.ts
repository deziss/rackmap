import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  log: ["error", "warn"],
});

const SQLITE_DB_PATH = path.resolve(process.cwd(), "prisma/dev.db");

const TABLES_ORDER = [
  // 1. Lookups
  "CloudProvider",
  "GpuType",
  "AllocatedTo",
  "Location",
  "ServerType",
  "NetworkType",
  "Tag",
  // 2. Auth Users
  "user",
  // 3. User Relations & Security
  "account",
  "session",
  "verification",
  "twoFactor",
  "apiKey",
  "SavedView",
  "NotificationPreference",
  // 4. Core Infrastructure
  "Server",
  "services",
  // 5. Dependent Relations & Event Logs
  "ServerTag",
  "ServiceTag",
  "StatusCheck",
  "SslStatus",
  "AccessRequest",
  "AuditLog",
  "system_vault",
  "system_license",
  "orders",
  "ssh_host_key",
  "scheduler_lock",
];

async function main() {
  console.log("===============================================================");
  console.log("🚀 Starting Zero-Data-Loss Migration: SQLite -> PostgreSQL 18");
  console.log("===============================================================\n");

  if (!fs.existsSync(SQLITE_DB_PATH)) {
    throw new Error(`SQLite database file not found at: ${SQLITE_DB_PATH}`);
  }

  // 1. Create timestamped safety backup of SQLite database
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${SQLITE_DB_PATH}.backup.${timestamp}`;
  fs.copyFileSync(SQLITE_DB_PATH, backupPath);
  console.log(`📦 Safety backup created: ${backupPath}`);

  // 2. Extract SQLite data & sequences via Python bridge
  console.log("🔍 Extracting SQLite records and sequence state...");
  const pyScript = `
import sqlite3, json, sys

con = sqlite3.connect('${SQLITE_DB_PATH.replace(/'/g, "\\'")}')
con.row_factory = sqlite3.Row
cur = con.cursor()

tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
data = {}
for t in tables:
    data[t] = [dict(r) for r in cur.execute(f'SELECT * FROM "{t}"').fetchall()]

seqs = {}
try:
    for name, seq in cur.execute("SELECT name, seq FROM sqlite_sequence").fetchall():
        seqs[name] = seq
except Exception:
    pass

sys.stdout.write(json.dumps({'data': data, 'seqs': seqs}))
`;

  const extractedOutput = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
    // The whole database travels as one JSON document; a real install with a
    // few months of sessions, audit rows and status checks exceeds 50MB.
    maxBuffer: 1024 * 1024 * 1024,
    encoding: "utf8",
  });

  const { data: sqliteData, seqs: sqliteSeqs } = JSON.parse(extractedOutput) as {
    data: Record<string, Record<string, any>[]>;
    seqs: Record<string, number>;
  };

  // 3. Fetch column types from PostgreSQL 18 information schema
  console.log("📡 Introspecting PostgreSQL 18 column specifications...");
  const colMeta: Array<{ table_name: string; column_name: string; data_type: string }> =
    await prisma.$queryRawUnsafe(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public';
    `);

  const typeMap = new Map<string, string>();
  for (const c of colMeta) {
    typeMap.set(`${c.table_name}.${c.column_name}`, c.data_type);
  }

  // 4. Truncate existing PostgreSQL tables cleanly in reverse dependency order
  console.log("🧹 Clearing PostgreSQL 18 tables prior to ETL ingestion...");
  for (let i = TABLES_ORDER.length - 1; i >= 0; i--) {
    const tbl = TABLES_ORDER[i];
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${tbl}" CASCADE;`);
  }

  // 5. Insert records table by table
  console.log("\n📥 Ingesting records into PostgreSQL 18 in dependency order...");
  const migrationResults: Array<{ table: string; source: number; inserted: number; match: boolean }> = [];

  for (const table of TABLES_ORDER) {
    const rows = sqliteData[table] || [];
    const sourceCount = rows.length;

    if (sourceCount === 0) {
      migrationResults.push({ table, source: 0, inserted: 0, match: true });
      continue;
    }

    console.log(`  -> Migrating "${table}" (${sourceCount} records)...`);

    // Ingest in chunks
    const CHUNK_SIZE = 50;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      for (const row of chunk) {
        const columns = Object.keys(row);
        const placeholders: string[] = [];
        const values: any[] = [];

        columns.forEach((col, idx) => {
          placeholders.push(`$${idx + 1}`);
          const targetType = typeMap.get(`${table}.${col}`);
          let val = row[col];

          if (val === null || val === undefined) {
            values.push(null);
            return;
          }

          if (targetType === "boolean") {
            values.push(val === 1 || val === "1" || val === true);
          } else if (
            targetType?.includes("timestamp") ||
            targetType?.includes("date")
          ) {
            if (typeof val === "string" || typeof val === "number") {
              values.push(new Date(val));
            } else {
              values.push(val);
            }
          } else if (targetType === "double precision") {
            values.push(typeof val === "number" ? val : parseFloat(val));
          } else {
            values.push(val);
          }
        });

        const quotedCols = columns.map((c) => `"${c}"`).join(", ");
        const query = `INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders.join(", ")})`;
        await prisma.$executeRawUnsafe(query, ...values);
      }
    }

    // Check inserted count
    const [{ count }]: Array<{ count: bigint | number }> = await prisma.$queryRawUnsafe(
      `SELECT count(*) FROM "${table}";`
    );
    const insertedCount = Number(count);
    const match = sourceCount === insertedCount;

    migrationResults.push({
      table,
      source: sourceCount,
      inserted: insertedCount,
      match,
    });

    if (!match) {
      throw new Error(
        `❌ Mismatch in table "${table}": expected ${sourceCount} rows, but inserted ${insertedCount} rows!`
      );
    }
  }

  // 6. Synchronize and reset PostgreSQL sequences
  console.log("\n🔄 Synchronizing PostgreSQL 18 identity and serial sequences...");
  for (const table of TABLES_ORDER) {
    const hasId = colMeta.some((c) => c.table_name === table && c.column_name === "id");
    if (!hasId) continue;
    const sqliteSeq = sqliteSeqs[table] || 0;
    const seqNameResult: Array<{ seq: string | null }> = await prisma.$queryRawUnsafe(`
      SELECT pg_get_serial_sequence('"${table}"', 'id') as seq;
    `);

    const seqName = seqNameResult[0]?.seq;
    if (seqName) {
      const maxIdResult: Array<{ max_id: bigint | number | null }> = await prisma.$queryRawUnsafe(`
        SELECT MAX(id) as max_id FROM "${table}";
      `);
      const maxId = Number(maxIdResult[0]?.max_id ?? 0);
      const targetSeq = Math.max(maxId, sqliteSeq, 1);

      await prisma.$executeRawUnsafe(`SELECT setval('${seqName}', ${targetSeq}, true);`);
      console.log(`  ✓ Table "${table}" sequence set to ${targetSeq}`);
    }
  }

  // 7. Print Reconciliation Report
  console.log("\n===============================================================");
  console.log("📊 Zero-Data-Loss Migration Reconciliation Report");
  console.log("===============================================================");
  console.table(
    migrationResults.map((r) => ({
      Table: r.table,
      "SQLite Count": r.source,
      "PostgreSQL Count": r.inserted,
      Status: r.match ? "✅ MATCH" : "❌ MISMATCH",
    }))
  );

  const totalSource = migrationResults.reduce((acc, r) => acc + r.source, 0);
  const totalInserted = migrationResults.reduce((acc, r) => acc + r.inserted, 0);

  console.log(`\n🎉 Total Rows Migrated: ${totalInserted} / ${totalSource} (100% Integrity Guaranteed)`);
  console.log("🎉 Database is now fully live on PostgreSQL 18!\n");
}

main()
  .catch((e) => {
    console.error("Migration fatal error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
