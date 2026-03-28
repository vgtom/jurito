-- AlterEnum
ALTER TYPE "PartySigningStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "DocumentParty" ADD COLUMN "inviteSentAt" TIMESTAMP(3),
ADD COLUMN "signingViewedAt" TIMESTAMP(3),
ADD COLUMN "rejectedAt" TIMESTAMP(3);
