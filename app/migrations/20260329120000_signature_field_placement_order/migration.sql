-- AlterTable
ALTER TABLE "SignatureField" ADD COLUMN "placementOrder" INTEGER NOT NULL DEFAULT 0;

-- Backfill per (document, party) in page order so existing templates get a stable signing sequence
UPDATE "SignatureField" AS sf
SET "placementOrder" = o.rn
FROM (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "documentId", "documentPartyId"
      ORDER BY "pageNumber", id
    ) - 1 AS rn
  FROM "SignatureField"
) AS o
WHERE sf.id = o.id;
