-- AlterTable
ALTER TABLE "SslStatus" ADD COLUMN     "lastAlertThreshold" INTEGER;

-- CreateTable
CREATE TABLE "alert_channel" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "managedBy" TEXT NOT NULL DEFAULT 'ui',
    "envKey" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretEnc" TEXT,
    "secretHint" TEXT,
    "events" TEXT[],
    "filters" JSONB,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_event" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'info',
    "dedupKey" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "serverId" INTEGER,
    "serviceId" INTEGER,
    "heartbeatId" INTEGER,
    "runbookRunId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_delivery" (
    "id" SERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "channelId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "heartbeat" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "serverId" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'cron',
    "schedule" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "periodSeconds" INTEGER,
    "graceSeconds" INTEGER NOT NULL DEFAULT 300,
    "maxRuntimeSeconds" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'new',
    "resumeOnPing" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnLate" BOOLEAN NOT NULL DEFAULT false,
    "lastPingAt" TIMESTAMP(3),
    "lastPingKind" TEXT,
    "lastStartAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastExitCode" INTEGER,
    "lastDurationMs" INTEGER,
    "expectedAt" TIMESTAMP(3),
    "alertAt" TIMESTAMP(3),
    "cronSource" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "heartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "heartbeat_ping" (
    "id" SERIAL NOT NULL,
    "heartbeatId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "exitCode" INTEGER,
    "durationMs" INTEGER,
    "remoteIp" TEXT,
    "userAgent" TEXT,
    "body" TEXT,
    "bodyTruncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "heartbeat_ping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runbook" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "script" TEXT NOT NULL,
    "interpreter" TEXT NOT NULL DEFAULT 'bash',
    "parameters" JSONB NOT NULL DEFAULT '[]',
    "runAs" TEXT NOT NULL DEFAULT 'sshUser',
    "timeoutSec" INTEGER NOT NULL DEFAULT 300,
    "concurrency" INTEGER NOT NULL DEFAULT 5,
    "maxFailures" INTEGER,
    "requireApproval" BOOLEAN NOT NULL DEFAULT false,
    "targetSelector" JSONB NOT NULL DEFAULT '{}',
    "allowTargetOverride" BOOLEAN NOT NULL DEFAULT true,
    "schedule" TEXT,
    "scheduleTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scheduleParamsEnc" TEXT,
    "nextScheduledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runbook_run" (
    "id" SERIAL NOT NULL,
    "runbookId" INTEGER NOT NULL,
    "runbookVersion" INTEGER NOT NULL,
    "scriptSnapshot" TEXT NOT NULL,
    "interpreter" TEXT NOT NULL,
    "runAs" TEXT NOT NULL,
    "timeoutSec" INTEGER NOT NULL,
    "concurrency" INTEGER NOT NULL,
    "maxFailures" INTEGER,
    "params" JSONB NOT NULL DEFAULT '{}',
    "paramsEnc" TEXT,
    "targetServerIds" JSONB NOT NULL DEFAULT '[]',
    "triggeredBy" TEXT NOT NULL DEFAULT 'user',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectionReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runbook_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runbook_host_result" (
    "id" SERIAL NOT NULL,
    "runId" INTEGER NOT NULL,
    "serverId" INTEGER,
    "hostname" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorCode" TEXT,
    "exitCode" INTEGER,
    "stdout" TEXT NOT NULL DEFAULT '',
    "stderr" TEXT NOT NULL DEFAULT '',
    "stdoutTruncated" BOOLEAN NOT NULL DEFAULT false,
    "stderrTruncated" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "runbook_host_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alert_channel_envKey_key" ON "alert_channel"("envKey");

-- CreateIndex
CREATE INDEX "alert_channel_enabled_idx" ON "alert_channel"("enabled");

-- CreateIndex
CREATE INDEX "alert_event_type_createdAt_idx" ON "alert_event"("type", "createdAt");

-- CreateIndex
CREATE INDEX "alert_event_createdAt_idx" ON "alert_event"("createdAt");

-- CreateIndex
CREATE INDEX "alert_delivery_status_nextAttemptAt_idx" ON "alert_delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "alert_delivery_channelId_createdAt_idx" ON "alert_delivery"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "alert_delivery_eventId_idx" ON "alert_delivery"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "heartbeat_tokenHash_key" ON "heartbeat"("tokenHash");

-- CreateIndex
CREATE INDEX "heartbeat_status_alertAt_idx" ON "heartbeat"("status", "alertAt");

-- CreateIndex
CREATE INDEX "heartbeat_status_expectedAt_idx" ON "heartbeat"("status", "expectedAt");

-- CreateIndex
CREATE INDEX "heartbeat_serverId_idx" ON "heartbeat"("serverId");

-- CreateIndex
CREATE INDEX "heartbeat_ping_heartbeatId_createdAt_idx" ON "heartbeat_ping"("heartbeatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "runbook_name_key" ON "runbook"("name");

-- CreateIndex
CREATE INDEX "runbook_scheduleEnabled_nextScheduledAt_idx" ON "runbook"("scheduleEnabled", "nextScheduledAt");

-- CreateIndex
CREATE INDEX "runbook_run_status_createdAt_idx" ON "runbook_run"("status", "createdAt");

-- CreateIndex
CREATE INDEX "runbook_run_runbookId_createdAt_idx" ON "runbook_run"("runbookId", "createdAt");

-- CreateIndex
CREATE INDEX "runbook_run_status_heartbeatAt_idx" ON "runbook_run"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "runbook_host_result_runId_status_idx" ON "runbook_host_result"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "runbook_host_result_runId_serverId_key" ON "runbook_host_result"("runId", "serverId");

-- AddForeignKey
ALTER TABLE "alert_channel" ADD CONSTRAINT "alert_channel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "alert_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_delivery" ADD CONSTRAINT "alert_delivery_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "alert_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heartbeat" ADD CONSTRAINT "heartbeat_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heartbeat" ADD CONSTRAINT "heartbeat_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heartbeat_ping" ADD CONSTRAINT "heartbeat_ping_heartbeatId_fkey" FOREIGN KEY ("heartbeatId") REFERENCES "heartbeat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook" ADD CONSTRAINT "runbook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook" ADD CONSTRAINT "runbook_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_run" ADD CONSTRAINT "runbook_run_runbookId_fkey" FOREIGN KEY ("runbookId") REFERENCES "runbook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_run" ADD CONSTRAINT "runbook_run_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_run" ADD CONSTRAINT "runbook_run_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_run" ADD CONSTRAINT "runbook_run_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_run" ADD CONSTRAINT "runbook_run_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_host_result" ADD CONSTRAINT "runbook_host_result_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runbook_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runbook_host_result" ADD CONSTRAINT "runbook_host_result_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;
