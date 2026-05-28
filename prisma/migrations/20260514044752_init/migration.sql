-- CreateTable
CREATE TABLE "Lot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotNumber" TEXT NOT NULL,
    "misoType" TEXT NOT NULL,
    "brewedAt" DATETIME NOT NULL,
    "totalWeightKg" REAL NOT NULL,
    "targetTempSum" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT '熟成中',
    "completedAt" DATETIME,
    "finalYieldKg" REAL,
    "yieldRate" REAL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BrewRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "mugiOrKomeKg" REAL NOT NULL,
    "kojiKg" REAL NOT NULL,
    "soybeanKg" REAL NOT NULL,
    "saltKg" REAL NOT NULL,
    "mizuameKg" REAL NOT NULL DEFAULT 0,
    "seedWaterL" REAL NOT NULL DEFAULT 0,
    "shikomiKg" REAL NOT NULL,
    "soybeanOrigin" TEXT,
    "soybeanOriginDetail" TEXT,
    "soybeanArrivalDate" DATETIME,
    "soybeanSupplier" TEXT,
    "soybeanLotNo" TEXT,
    "kojiMadeAt" DATETIME,
    "kojiSupplier" TEXT,
    "saltBrand" TEXT,
    "saltLotNo" TEXT,
    "mizuameBrand" TEXT,
    "mizuameLotNo" TEXT,
    "kojiCondition" INTEGER,
    "soybeanHardness" TEXT,
    "airTempC" REAL,
    "productTempC" REAL,
    "steamingPressure" TEXT,
    "coolingMin" TEXT,
    "seedMisoKg" REAL NOT NULL DEFAULT 0,
    "memo" TEXT,
    CONSTRAINT "BrewRecord_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LocationHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME,
    "location" TEXT NOT NULL,
    CONSTRAINT "LocationHistory_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgingNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memo" TEXT NOT NULL,
    "airTempC" REAL,
    "productTempC" REAL,
    CONSTRAINT "AgingNote_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BrewDiary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "categories" TEXT NOT NULL,
    "tags" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    CONSTRAINT "BrewDiary_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SeedMisoUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromLotId" TEXT NOT NULL,
    "toLotId" TEXT NOT NULL,
    "usedKg" REAL NOT NULL,
    "usedAt" DATETIME NOT NULL,
    CONSTRAINT "SeedMisoUsage_fromLotId_fkey" FOREIGN KEY ("fromLotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SeedMisoUsage_toLotId_fkey" FOREIGN KEY ("toLotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PackagingLot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lotId" TEXT NOT NULL,
    "packagedLotNumber" TEXT NOT NULL,
    "expiryDate" DATETIME NOT NULL,
    "alcoholAddedAt" DATETIME,
    "filledAt" DATETIME,
    "bucketId" TEXT,
    "textureType" TEXT NOT NULL,
    "shikomiKg" REAL,
    "filled1kgCount" INTEGER NOT NULL DEFAULT 0,
    "filled500gCount" INTEGER NOT NULL DEFAULT 0,
    "orderNo" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PackagingLot_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WeatherCache" (
    "date" DATETIME NOT NULL PRIMARY KEY,
    "avgTempC" REAL NOT NULL,
    "effectiveTemp" REAL NOT NULL
);

-- CreateTable
CREATE TABLE "ShipmentHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "yearMonth" TEXT NOT NULL,
    "misoType" TEXT NOT NULL,
    "weightKg" REAL NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IngredientAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "triggerLotId" TEXT NOT NULL,
    "affectedLotId" TEXT NOT NULL,
    "ingredientType" TEXT NOT NULL,
    "lotNo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE UNIQUE INDEX "Lot_lotNumber_key" ON "Lot"("lotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BrewRecord_lotId_key" ON "BrewRecord"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "PackagingLot_packagedLotNumber_key" ON "PackagingLot"("packagedLotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentHistory_yearMonth_misoType_key" ON "ShipmentHistory"("yearMonth", "misoType");
