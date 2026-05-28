-- CreateTable
CREATE TABLE "BucketUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bucketId" TEXT NOT NULL,
    "usedAt" DATETIME NOT NULL,
    "usedKg" REAL NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BucketUsage_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
