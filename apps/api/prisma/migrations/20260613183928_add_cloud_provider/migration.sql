/*
  Warnings:

  - You are about to drop the `Domain` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `domainId` on the `Server` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Domain_name_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Domain";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "CloudProvider" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Server" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hostname" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEnc" TEXT,
    "sshPort" INTEGER NOT NULL DEFAULT 22,
    "cpu" TEXT,
    "ram" TEXT,
    "gpuCount" INTEGER,
    "remark" TEXT,
    "domain" TEXT,
    "environment" TEXT DEFAULT 'on-premise',
    "cloudProviderId" INTEGER,
    "gpuTypeId" INTEGER,
    "allocatedToId" INTEGER,
    "locationId" INTEGER,
    "serverTypeId" INTEGER,
    "lastStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" DATETIME,
    "lastLatencyMs" INTEGER,
    "downStreak" INTEGER NOT NULL DEFAULT 0,
    "notifiedDown" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Server_cloudProviderId_fkey" FOREIGN KEY ("cloudProviderId") REFERENCES "CloudProvider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Server_gpuTypeId_fkey" FOREIGN KEY ("gpuTypeId") REFERENCES "GpuType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Server_allocatedToId_fkey" FOREIGN KEY ("allocatedToId") REFERENCES "AllocatedTo" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Server_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Server_serverTypeId_fkey" FOREIGN KEY ("serverTypeId") REFERENCES "ServerType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Server" ("allocatedToId", "cpu", "createdAt", "deletedAt", "downStreak", "gpuCount", "gpuTypeId", "hostname", "id", "ip", "lastCheckedAt", "lastLatencyMs", "lastStatus", "locationId", "notifiedDown", "passwordEnc", "ram", "remark", "serverTypeId", "sshPort", "updatedAt", "username") SELECT "allocatedToId", "cpu", "createdAt", "deletedAt", "downStreak", "gpuCount", "gpuTypeId", "hostname", "id", "ip", "lastCheckedAt", "lastLatencyMs", "lastStatus", "locationId", "notifiedDown", "passwordEnc", "ram", "remark", "serverTypeId", "sshPort", "updatedAt", "username" FROM "Server";
DROP TABLE "Server";
ALTER TABLE "new_Server" RENAME TO "Server";
CREATE INDEX "Server_cloudProviderId_idx" ON "Server"("cloudProviderId");
CREATE INDEX "Server_gpuTypeId_idx" ON "Server"("gpuTypeId");
CREATE INDEX "Server_allocatedToId_idx" ON "Server"("allocatedToId");
CREATE INDEX "Server_locationId_idx" ON "Server"("locationId");
CREATE INDEX "Server_serverTypeId_idx" ON "Server"("serverTypeId");
CREATE INDEX "Server_deletedAt_idx" ON "Server"("deletedAt");
CREATE INDEX "Server_hostname_idx" ON "Server"("hostname");
CREATE INDEX "Server_ip_idx" ON "Server"("ip");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CloudProvider_name_key" ON "CloudProvider"("name");
