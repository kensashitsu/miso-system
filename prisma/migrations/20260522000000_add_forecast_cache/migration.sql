-- CreateTable
CREATE TABLE "ForecastCache" (
    "misoType" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "forecastKg" REAL NOT NULL,
    "lower90" REAL NOT NULL,
    "upper90" REAL NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("misoType", "yearMonth")
);
