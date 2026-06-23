-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "newServerAdded" BOOLEAN NOT NULL DEFAULT false,
    "serverUpDown" BOOLEAN NOT NULL DEFAULT false,
    "gpuCountChanged" BOOLEAN NOT NULL DEFAULT false,
    "diskUnmounted" BOOLEAN NOT NULL DEFAULT false,
    "diskFull" BOOLEAN NOT NULL DEFAULT false,
    "ramFull" BOOLEAN NOT NULL DEFAULT false,
    "highCpu" BOOLEAN NOT NULL DEFAULT false,
    "userRegistered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "NotificationPreference_userId_idx" ON "NotificationPreference"("userId");
