-- CreateTable
CREATE TABLE "SignatureFieldCompletion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureFieldId" TEXT NOT NULL,
    "documentPartyId" TEXT NOT NULL,
    "textValue" TEXT,
    "imageObjectKey" TEXT,

    CONSTRAINT "SignatureFieldCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignatureFieldCompletion_signatureFieldId_documentPartyId_key" ON "SignatureFieldCompletion"("signatureFieldId", "documentPartyId");

-- AddForeignKey
ALTER TABLE "SignatureFieldCompletion" ADD CONSTRAINT "SignatureFieldCompletion_signatureFieldId_fkey" FOREIGN KEY ("signatureFieldId") REFERENCES "SignatureField"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureFieldCompletion" ADD CONSTRAINT "SignatureFieldCompletion_documentPartyId_fkey" FOREIGN KEY ("documentPartyId") REFERENCES "DocumentParty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
