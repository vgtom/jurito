-- CreateTable
CREATE TABLE "DocumentParty" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sortOrder" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,

    CONSTRAINT "DocumentParty_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentParty_documentId_sortOrder_key" ON "DocumentParty"("documentId", "sortOrder");

ALTER TABLE "DocumentParty" ADD CONSTRAINT "DocumentParty_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "SignatureField" ADD COLUMN "documentPartyId" TEXT;

-- One "First party" per existing document
INSERT INTO "DocumentParty" ("id", "createdAt", "sortOrder", "label", "documentId")
SELECT gen_random_uuid()::text, CURRENT_TIMESTAMP, 0, 'First party', d."id"
FROM "Document" d;

UPDATE "SignatureField" sf
SET "documentPartyId" = dp."id"
FROM "DocumentParty" dp
WHERE dp."documentId" = sf."documentId" AND dp."sortOrder" = 0;

ALTER TABLE "SignatureField" ALTER COLUMN "documentPartyId" SET NOT NULL;

ALTER TABLE "SignatureField" ADD CONSTRAINT "SignatureField_documentPartyId_fkey" FOREIGN KEY ("documentPartyId") REFERENCES "DocumentParty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
