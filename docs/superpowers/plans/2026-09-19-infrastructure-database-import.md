# Infrastructure Data Import & Database Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest and normalize the provided organization infrastructure CSV (21 Grafana credentials, 14 backup schedules, 30 Kubernetes applications, 8 AI inference nodes with 28+ models, 14 AWS cloud servers, and 4 AWS root accounts/IAM credentials) into `Server`, `Service`, `CloudProvider`, `AllocatedTo`, and `Location` database models with AES-256-GCM / vault encryption for all credentials.

**Architecture:** A TypeScript/Node.js ingestion pipeline (`apps/api/prisma/import-infrastructure-data.ts`) utilizing Prisma ORM with idempotent upsert logic. Lookups are created or mapped first, existing servers (16 matching) are updated with backup and model metadata, missing servers (16 new) are inserted with SSH ports and specs, services (K8s apps, AI endpoints, Grafana accounts) are securely stored with encrypted passwords, and changes are applied to both local and production Docker SQLite databases.

**Tech Stack:** TypeScript, Prisma ORM, SQLite (`inventory.db`), AES-256-GCM / PBKDF2 Envelope Vault Encryption, Node.js.

---

## User Review Required

> [!IMPORTANT]
> **Credential Storage Strategy**: All passwords (e.g. Grafana `Merai@123$%`, Bytebase `Merai@123`, MySQL `Merai@123`, MinIO passwords, and AI inference API tokens like `rlH1DdwV0Bmn59thTkl9RcS0MbAnBWJB`) will be encrypted at rest using `encryptPasswordWithVault(plaintext)` (AES-256-GCM) before being persisted to the `passwordEnc` fields.
> 
> **Database Targets**: The import script will be executed against:
> 1. The active production database mounted in the Docker container (`server-inventory-api-1:/data/inventory.db`).
> 2. The local development database (`apps/api/prisma/dev.db`) for parity during local testing and development.

---

## Data Breakdown & Schema Mapping

| Category | Count | Source Data | Target Prisma Model | Key Fields & Transformation |
| :--- | :--- | :--- | :--- | :--- |
| **1. Grafana Credentials** | 21 | Admin, Bengluru, Chennai, Delhi, Kanpur, etc. | `Service` | `serviceName: "Grafana (<team>)"`, `serviceType: "monitoring"`, `username`, `passwordEnc` (AES-256-GCM), `remark: "Role/Dashboard access"` |
| **2. Backup Schedules** | 14 | 10.10.110.21 - 10.10.110.173, scripts, cron, durability | `Server` & `Service` | Update `Server.remark` with backup scripts (`docker_dump.sh`, `k8s_backup.sh`), destinations, cron periods, and durability; add backup service records |
| **3. Kubernetes Apps** | 30 | Aim, Bytebase, Cassandra, Clickhouse, Minio, etc. | `Service` | `serviceName`, `serviceType: "k8s-app" / "database" / "storage"`, `port: NodePort`, `domain: Domain URL`, `username`, `passwordEnc` |
| **4. AI Inference Nodes** | 8 nodes (28+ models) | Ollama, vLLM, llama.cpp on 10.120.130.44 - .69 | `Server` & `Service` | Update/Create `Server` with DMZ/Local zone and Team; create individual `Service` entries for each model/port (e.g. Qwen, Llama3, Nemotron) |
| **5. AWS Cloud Servers** | 14 | 15.207.42.250, 3.110.130.123, 13.204.153.239, etc. | `Server` | `cloudProvider: "AWS"`, `sshPort` (7722 / 22), `location` (AWS-Chennai, AWS-Vapi, us-east-1), `allocatedTo` (Team), `osType: "linux"` |
| **6. AWS Accounts & IAM** | 4 accounts, 3 keys | Chennai, Bengaluru, Kanpur, Vapi + IAM keys | `Service` | `serviceName: "AWS Account - <Team>"`, `serviceType: "cloud-account"`, `domain: Console URL`, `username`, `remark: "Account ID"` |

---

## Proposed Changes

### Database Ingestion & Management

#### [NEW] [import-infrastructure-data.ts](file:///home/anshukushwaha/Desktop/learn/server-inventory/apps/api/prisma/import-infrastructure-data.ts)
- Comprehensive, modular ingestion script:
  - Parses and structures all 6 datasets.
  - Ensures lookups exist in `CloudProvider`, `AllocatedTo`, `Location`, and `Tag`.
  - Performs idempotent upserts for all 32 servers (16 existing updated, 16 new inserted).
  - Performs idempotent upserts for all 65+ services (Grafana credentials, K8s applications, AI models, AWS accounts).
  - Uses `encryptPasswordWithVault` or fallback `encryptSecret` to securely encrypt sensitive credentials before storage.
  - Outputs a detailed audit summary showing count of inserted, updated, and skipped records.

#### [MODIFY] [package.json](file:///home/anshukushwaha/Desktop/learn/server-inventory/apps/api/package.json)
- Add convenience script: `"db:import-infra": "tsx prisma/import-infrastructure-data.ts"`.

---

## Step-by-Step Execution Plan

### Task 1: Create the Ingestion Dataset & Script
**Files:**
- Create: `apps/api/prisma/import-infrastructure-data.ts`
- Modify: `apps/api/package.json`

- [ ] **Step 1: Write `apps/api/prisma/import-infrastructure-data.ts`**
  - Implement lookup resolution:
    - Cloud Providers: `AWS`, `On-Premise`, `Local`
    - Allocated Teams: `CHENNAI TEAM`, `BENGALURU TEAM`, `KANPUR TEAM`, `VAPI TEAM`, `NuOmics`, `Nupat`, `Numol`, `Siddharth`, `Devops`, `Data Engineer`
    - Locations: `AWS-Chennai`, `AWS-Vapi`, `AWS-us-east-1`, `AWS-me-central-1`, `AWS-ap-south-1`, `DMZ`, `Local`, `Chennai`, `Bengaluru`, `Delhi`, `Kanpur`
  - Implement Server upsert logic matching on `ip`.
  - Implement Service upsert logic matching on `serviceName` + `serverIp` / `domain`.
  - Implement credential encryption using `apps/api/src/services/vault.service.ts`.

- [ ] **Step 2: Dry-run and validate against local dev database**
  - Run: `pnpm --filter @inv/api run db:import-infra`
  - Verify lookups, servers, and services counts.

- [ ] **Step 3: Apply changes to Docker container database**
  - Copy and execute the import script inside `server-inventory-api-1`.
  - Verify data integrity in `/data/inventory.db`.

### Task 2: Verify API & UI Endpoints
**Files:**
- Test via curl and web console

- [ ] **Step 1: Verify API servers endpoint**
  - Test `/api/v1/servers` returns updated and newly added servers with correct teams and backup remarks.
- [ ] **Step 2: Verify API services endpoint**
  - Test `/api/v1/services` returns Kubernetes apps, AI models, and Grafana entries.
- [ ] **Step 3: Verify existing tests continue to pass**
  - Run `pnpm test` to ensure 28/28 tests remain green without regression.

### Task 3: Local Commit
- [ ] **Step 1: Stage and commit changes locally**
  - Adhere to the rule: **DO NOT PUSH TO REMOTE**.
  - Local commit with descriptive message.

---

## Verification Plan

### Automated Tests
- `pnpm --filter @inv/api test`: Ensure existing test suite passes with zero errors.
- `docker exec server-inventory-api-1 node -e '...'`: Validate counts of servers (from 81 to 97+) and services (from 1 to 65+).

### Manual Verification
- Query sample records:
  - Check AWS server `15.207.42.250` (aws_chennai) with SSH port 7722 and team `CHENNAI TEAM`.
  - Check AI server `10.120.130.69` (MDGP051) with model `Qwen3.5-122B-A10B-BF16` and token.
  - Check K8s app `Bytebase` with domain `https://bytebase.merai.app/` and encrypted credentials.
  - Check Grafana accounts in `Service` table.
