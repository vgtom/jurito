-- CreateTable
CREATE TABLE "DocumentFolder" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "DocumentFolder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentFolder_userId_name_key" ON "DocumentFolder"("userId", "name");

ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Document" ADD COLUMN "folderId" TEXT;
ALTER TABLE "Document" ADD COLUMN "sentAt" TIMESTAMP(3);

INSERT INTO "DocumentFolder" ("id", "createdAt", "name", "userId")
SELECT gen_random_uuid()::text, CURRENT_TIMESTAMP, 'MyFolder', u."userId"
FROM (SELECT DISTINCT "userId" FROM "Document") u
WHERE NOT EXISTS (
    SELECT 1 FROM "DocumentFolder" f WHERE f."userId" = u."userId" AND f."name" = 'MyFolder'
);

UPDATE "Document" d
SET "folderId" = f."id"
FROM "DocumentFolder" f
WHERE f."userId" = d."userId" AND f."name" = 'MyFolder';

UPDATE "Document" SET "sentAt" = "createdAt" WHERE "status" IN ('SENT', 'SIGNED') AND "sentAt" IS NULL;

ALTER TABLE "Document" ALTER COLUMN "folderId" SET NOT NULL;

ALTER TABLE "Document" ADD CONSTRAINT "Document_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "DocumentFolder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
