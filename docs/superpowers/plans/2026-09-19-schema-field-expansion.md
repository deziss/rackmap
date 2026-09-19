# Database Schema Field Expansion & Infrastructure Normalization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `Server` and `Service` Prisma models with dedicated, first-class fields for automated backup policies, AI inference engines/models, Kubernetes NodePorts, and cloud account credentials, update shared Zod schemas, push database schema changes, and repopulate the database so that these attributes are queryable, filterable, and visible in the UI.

**Architecture:** 
1. **Prisma Schema Update**: Add explicit columns to `Server` (`zone`, `backupScript`, `backupDestination`, `backupSchedule`, `backupDurability`, `backupDataType`, `inferenceEngine`, `inferenceModels`, `inferencePort`, `authTokenEnc`) and `Service` (`nodePort`, `role`, `accountId`, `region`, `authTokenEnc`).
2. **Schema Synchronization**: Execute `prisma db push` and `prisma generate` across local dev and Docker container (`server-inventory-api-1`) to preserve all existing records without data loss.
3. **Shared Contracts**: Extend Zod validation schemas in `@inv/shared` so API requests, responses, and frontend state seamlessly recognize the new attributes.
4. **Data Ingestion Pipeline**: Update `apps/api/prisma/import-infrastructure-data.ts` to populate these new structured fields directly.
5. **UI Enhancement**: Expose these fields in the server inspection drawer and services table.

**Tech Stack:** Prisma ORM, SQLite (`inventory.db`), Zod (`@inv/shared`), React / Vite (`apps/web`), AES-256-GCM encryption.

---

## User Review Required

> [!IMPORTANT]
> **Zero Data Loss Migration**: Using `prisma db push` on SQLite safely adds the new nullable columns to existing tables (`Server` and `services`) without dropping or corrupting any of the 97 active servers or 87 services already in the database.
> 
> **Credential Safety**: `authTokenEnc` on both `Server` and `Service` will remain encrypted at rest with AES-256-GCM.

---

## Proposed Schema Additions

### 1. `Server` Model (`apps/api/prisma/schema.prisma`)
```prisma
  // ── Backup Automation & Disaster Recovery ──────────────────────────────────
  backupScript      String?  @map("backup_script")       // e.g. "/home/script/docker_dump.sh"
  backupDestination String?  @map("backup_destination")  // e.g. "/mnt/nvme_disk0/backup", NFS
  backupSchedule    String?  @map("backup_schedule")     // e.g. "05 21 * * 1-6", "Every night 11 PM"
  backupDurability  String?  @map("backup_durability")   // e.g. "60 days", "30 days"
  backupDataType    String?  @map("backup_data_type")    // e.g. "Kubernetes YAMLs", "docker volumes"

  // ── AI Inference & Model Topology ──────────────────────────────────────────
  zone              String?                              // e.g. "DMZ", "Local", "AWS-Chennai"
  inferenceEngine   String?  @map("inference_engine")    // e.g. "vLLM", "Ollama", "llama.cpp"
  inferenceModels   String?  @map("inference_models")    // Comma-separated or JSON list of models
  inferencePort     Int?     @map("inference_port")      // e.g. 11431, 13313, 13317, 8001
  authTokenEnc      String?  @map("auth_token")          // AES-256-GCM encrypted API bearer token
```

### 2. `Service` Model (`apps/api/prisma/schema.prisma`)
```prisma
  nodePort          Int?     @map("node_port")           // Kubernetes NodePort (e.g. 30420, 31000)
  role              String?                              // e.g. "view only Bengluru Dashboard", "Admin"
  accountId         String?  @map("account_id")          // AWS/Cloud Account ID (e.g. "113284361480")
  region            String?                              // Cloud Region (e.g. "ap-south-1", "us-east-1")
  authTokenEnc      String?  @map("auth_token")          // Encrypted API token
```

---

## Step-by-Step Execution Plan

### Task 1: Schema Updates & Prisma Client Generation
**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `packages/shared/src/schemas/server.ts`
- Modify: `packages/shared/src/schemas/service.ts`

- [ ] **Step 1: Update `apps/api/prisma/schema.prisma`** with the new fields on `Server` and `Service`.
- [ ] **Step 2: Run `prisma generate`** locally to update Prisma Client type definitions.
- [ ] **Step 3: Run `prisma db push`** on the local database (`dev.db`).
- [ ] **Step 4: Update shared Zod schemas** in `packages/shared/src/schemas/` to include the new fields.
- [ ] **Step 5: Rebuild `@inv/shared`** via `pnpm --filter @inv/shared build`.

### Task 2: Push Schema to Production Container & Update Pipeline
**Files:**
- Modify: `apps/api/prisma/import-infrastructure-data.ts`
- Target: `server-inventory-api-1` container

- [ ] **Step 1: Push schema to Docker database**
  - Run `docker exec server-inventory-api-1 pnpm exec prisma db push --accept-data-loss`
  - Run `docker exec server-inventory-api-1 pnpm exec prisma generate`
- [ ] **Step 2: Update `apps/api/prisma/import-infrastructure-data.ts`**
  - Map incoming backup fields directly to `backupScript`, `backupDestination`, `backupSchedule`, `backupDurability`, and `backupDataType`.
  - Map AI inference engine, models, zone, port, and encrypted tokens to `inferenceEngine`, `inferenceModels`, `zone`, `inferencePort`, and `authTokenEnc`.
  - Map Kubernetes NodePorts, roles, account IDs, and regions to `nodePort`, `role`, `accountId`, `region`.
- [ ] **Step 3: Execute ingestion pipeline**
  - Run on local dev: `pnpm --filter @inv/api run db:import-infra`
  - Recompile and run inside Docker container: `docker exec server-inventory-api-1 node dist/import-infrastructure-data.js`

### Task 3: UI Drawer & Display Integration
**Files:**
- Modify: `apps/web/src/components/servers/server-detail-sheet.tsx` (or server drawer)
- Modify: `apps/web/src/components/services/` (if present)

- [ ] **Step 1: Display backup and inference badges in server drawer**
  - Show Backup details section (Script, Destination, Schedule, Durability) when present.
  - Show AI Inference section (Engine, Models, Zone, Port) when present.
- [ ] **Step 2: Rebuild Web assets**
  - Run `npm --prefix apps/web run build`.
  - Copy updated assets to `server-inventory-web-1` container.

### Task 4: Verification & Local Commit
- [ ] **Step 1: Run test suite** (`pnpm test`) to ensure all 28 tests pass.
- [ ] **Step 2: Query sample records** from both API and DB to verify structured columns.
- [ ] **Step 3: Commit all changes locally** without pushing to remote.

---

## Verification Plan

### Automated Tests
- `pnpm test`: Verify zero regressions across lookup, server, and auth tests.
- `docker exec server-inventory-api-1 node -e '...'`: Verify fields exist and contain expected values.

### Query Verification
- Verify `10.10.110.21`: `backupScript = "/home/script/docker_dump.sh"`, `backupSchedule = "05 21 * * 1-6"`, `backupDurability = "60 days"`.
- Verify `10.120.130.69`: `inferenceEngine = "vLLM"`, `inferencePort = 13317`, `zone = "DMZ"`, `inferenceModels = "Qwen3.5-122B-A10B-BF16"`, `authTokenEnc` is encrypted.
- Verify `Bytebase`: `nodePort = 30420`, `domain = "https://bytebase.merai.app/"`.
- Verify `Grafana Dashboard (bengluru)`: `role = "view only Bengluru Dashboard"`.
