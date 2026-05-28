-- CreateTable
CREATE TABLE "MisoRecipe" (
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
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MisoRecipe_name_key" ON "MisoRecipe"("name");
