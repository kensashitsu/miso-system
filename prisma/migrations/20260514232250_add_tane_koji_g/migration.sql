-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BrewRecord" (
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
    "taneKojiG" REAL NOT NULL DEFAULT 0,
    "memo" TEXT,
    CONSTRAINT "BrewRecord_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_BrewRecord" ("airTempC", "coolingMin", "id", "kojiCondition", "kojiKg", "kojiMadeAt", "kojiSupplier", "lotId", "memo", "mizuameBrand", "mizuameKg", "mizuameLotNo", "mugiOrKomeKg", "productTempC", "saltBrand", "saltKg", "saltLotNo", "seedMisoKg", "seedWaterL", "shikomiKg", "soybeanArrivalDate", "soybeanHardness", "soybeanKg", "soybeanLotNo", "soybeanOrigin", "soybeanOriginDetail", "soybeanSupplier", "steamingPressure") SELECT "airTempC", "coolingMin", "id", "kojiCondition", "kojiKg", "kojiMadeAt", "kojiSupplier", "lotId", "memo", "mizuameBrand", "mizuameKg", "mizuameLotNo", "mugiOrKomeKg", "productTempC", "saltBrand", "saltKg", "saltLotNo", "seedMisoKg", "seedWaterL", "shikomiKg", "soybeanArrivalDate", "soybeanHardness", "soybeanKg", "soybeanLotNo", "soybeanOrigin", "soybeanOriginDetail", "soybeanSupplier", "steamingPressure" FROM "BrewRecord";
DROP TABLE "BrewRecord";
ALTER TABLE "new_BrewRecord" RENAME TO "BrewRecord";
CREATE UNIQUE INDEX "BrewRecord_lotId_key" ON "BrewRecord"("lotId");
CREATE TABLE "new_MisoRecipe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "grainLabel" TEXT NOT NULL,
    "grainKg" REAL NOT NULL,
    "soybeanKg" REAL NOT NULL,
    "saltKg" REAL NOT NULL,
    "mizuameKg" REAL NOT NULL DEFAULT 0,
    "totalWeightKg" REAL NOT NULL,
    "targetTempSum" REAL NOT NULL,
    "defaultLocation" TEXT NOT NULL DEFAULT '温調室24℃',
    "soybeanOrigin" TEXT,
    "taneKojiG" REAL NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_MisoRecipe" ("createdAt", "defaultLocation", "grainKg", "grainLabel", "id", "isActive", "mizuameKg", "name", "saltKg", "sortOrder", "soybeanKg", "soybeanOrigin", "targetTempSum", "totalWeightKg", "updatedAt") SELECT "createdAt", "defaultLocation", "grainKg", "grainLabel", "id", "isActive", "mizuameKg", "name", "saltKg", "sortOrder", "soybeanKg", "soybeanOrigin", "targetTempSum", "totalWeightKg", "updatedAt" FROM "MisoRecipe";
DROP TABLE "MisoRecipe";
ALTER TABLE "new_MisoRecipe" RENAME TO "MisoRecipe";
CREATE UNIQUE INDEX "MisoRecipe_name_key" ON "MisoRecipe"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
