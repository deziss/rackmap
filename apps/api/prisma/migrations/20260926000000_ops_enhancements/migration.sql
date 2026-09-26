-- CreateTable
CREATE TABLE "server_patch_status" (
    "id" SERIAL NOT NULL,
    "serverId" INTEGER NOT NULL,
    "packageManager" TEXT,
    "upgradableCount" INTEGER NOT NULL DEFAULT 0,
    "securityCount" INTEGER NOT NULL DEFAULT 0,
    "rebootRequired" BOOLEAN NOT NULL DEFAULT false,
    "kernelRunning" TEXT,
    "kernelLatest" TEXT,
    "osPretty" TEXT,
    "packages" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ok',
    "error" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAppliedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "server_patch_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_snapshot" (
    "id" SERIAL NOT NULL,
    "serverId" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "isBaseline" BOOLEAN NOT NULL DEFAULT false,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drift_event" (
    "id" SERIAL NOT NULL,
    "serverId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "summary" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "snapshotId" INTEGER,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,

    CONSTRAINT "drift_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_grant" (
    "id" SERIAL NOT NULL,
    "serverId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "keyFingerprint" TEXT,
    "onExpiry" TEXT NOT NULL DEFAULT 'lock',
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "server_patch_status_serverId_key" ON "server_patch_status"("serverId");

-- CreateIndex
CREATE INDEX "server_patch_status_securityCount_idx" ON "server_patch_status"("securityCount");

-- CreateIndex
CREATE INDEX "server_patch_status_rebootRequired_idx" ON "server_patch_status"("rebootRequired");

-- CreateIndex
CREATE INDEX "server_snapshot_serverId_takenAt_idx" ON "server_snapshot"("serverId", "takenAt");

-- CreateIndex
CREATE INDEX "drift_event_serverId_detectedAt_idx" ON "drift_event"("serverId", "detectedAt");

-- CreateIndex
CREATE INDEX "drift_event_acknowledgedAt_idx" ON "drift_event"("acknowledgedAt");

-- CreateIndex
CREATE INDEX "access_grant_status_expiresAt_idx" ON "access_grant"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "access_grant_serverId_idx" ON "access_grant"("serverId");

-- AddForeignKey
ALTER TABLE "server_patch_status" ADD CONSTRAINT "server_patch_status_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_snapshot" ADD CONSTRAINT "server_snapshot_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_event" ADD CONSTRAINT "drift_event_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_event" ADD CONSTRAINT "drift_event_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
