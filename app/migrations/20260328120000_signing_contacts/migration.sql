-- CreateEnum
CREATE TYPE "PartySigningStatus" AS ENUM ('NOT_SENT', 'AWAITING_SIGNATURE', 'COMPLETED');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "preserveSigningOrder" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "DocumentParty" ADD COLUMN "signerName" TEXT,
ADD COLUMN "signerEmail" TEXT,
ADD COLUMN "signingToken" TEXT,
ADD COLUMN "signingStatus" "PartySigningStatus" NOT NULL DEFAULT 'NOT_SENT';

CREATE UNIQUE INDEX "DocumentParty_signingToken_key" ON "DocumentParty"("signingToken");

-- CreateTable
CREATE TABLE "UserContact" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "UserContact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserContact_userId_email_key" ON "UserContact"("userId", "email");

CREATE INDEX "UserContact_userId_idx" ON "UserContact"("userId");

ALTER TABLE "UserContact" ADD CONSTRAINT "UserContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
