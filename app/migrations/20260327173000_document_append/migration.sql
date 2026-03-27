-- CreateTable
CREATE TABLE "DocumentAppend" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sortOrder" INTEGER NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,

    CONSTRAINT "DocumentAppend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAppend_documentId_sortOrder_key" ON "DocumentAppend"("documentId", "sortOrder");

-- AddForeignKey
ALTER TABLE "DocumentAppend" ADD CONSTRAINT "DocumentAppend_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
