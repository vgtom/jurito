import {
  DocumentStatus,
  SignatureFieldType,
  UserPlan,
} from "@prisma/client";
import { randomUUID } from "crypto";
import * as path from "path";
import { type Document, type SignatureField, type SignatureImage } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import {
  type CreateDocument,
  type DeleteDocument,
  type GetDocumentForEditor,
  type GetDocuments,
  type SaveSignatureImage,
  type SaveFields,
  type SendDocument,
} from "wasp/server/operations";
import * as z from "zod";

import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import { getPresignedUrl, uploadFile } from "./objectStorage";

const PDF_MAGIC = Buffer.from("%PDF");

const MAX_PDF_BYTES = 20 * 1024 * 1024;

const createDocumentInputSchema = z.object({
  fileName: z.string().min(1).max(512),
  fileBase64: z.string().min(1),
  contentType: z.literal("application/pdf").optional(),
});

type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;

function isPdfBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC);
}

export const createDocument: CreateDocument<
  CreateDocumentInput,
  Document
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const args = ensureArgsSchemaOrThrowHttpError(
    createDocumentInputSchema,
    rawArgs,
  );

  const user = await context.entities.User.findUniqueOrThrow({
    where: { id: context.user.id },
    select: { plan: true, isAdmin: true },
  });

  const existingCount = await context.entities.Document.count({
    where: { userId: context.user.id },
  });

  const planLimited =
    !user.isAdmin && user.plan === UserPlan.FREE && existingCount >= 1;

  if (planLimited) {
    throw new HttpError(
      403,
      "Free plan allows one document. Upgrade to Pro to upload more.",
    );
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(args.fileBase64, "base64");
  } catch {
    throw new HttpError(400, "Invalid file data.");
  }

  if (buffer.length === 0) {
    throw new HttpError(400, "Empty file.");
  }
  if (buffer.length > MAX_PDF_BYTES) {
    throw new HttpError(400, "File is too large (max 20MB).");
  }
  if (!isPdfBuffer(buffer)) {
    throw new HttpError(400, "Only PDF files are allowed.");
  }

  const safeBase = path.basename(args.fileName).replace(/[^\w.\-]+/g, "_");
  const ext = path.extname(safeBase) || ".pdf";
  const objectKey = `${context.user.id}/${randomUUID()}${ext}`;

  await uploadFile({
    objectKey,
    data: buffer,
    contentType: args.contentType ?? "application/pdf",
  });

  return context.entities.Document.create({
    data: {
      name: safeBase || "document.pdf",
      fileUrl: objectKey,
      status: DocumentStatus.DRAFT,
      user: { connect: { id: context.user.id } },
    },
  });
};

export const getDocuments: GetDocuments<void, Document[]> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  return context.entities.Document.findMany({
    where: { userId: context.user.id },
    orderBy: { createdAt: "desc" },
  });
};

const documentIdSchema = z.object({
  documentId: z.string().uuid(),
});

export type DocumentForEditorPayload = {
  document: Document;
  fields: SignatureField[];
  pdfUrl: string;
};

export const getDocumentForEditor: GetDocumentForEditor<
  z.infer<typeof documentIdSchema>,
  DocumentForEditorPayload
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { documentId } = ensureArgsSchemaOrThrowHttpError(
    documentIdSchema,
    rawArgs,
  );

  const document = await context.entities.Document.findFirst({
    where: { id: documentId, userId: context.user.id },
  });

  if (!document) {
    throw new HttpError(404, "Document not found.");
  }

  const fields = await context.entities.SignatureField.findMany({
    where: { documentId: document.id },
    orderBy: { pageNumber: "asc" },
  });

  const pdfUrl = await getPresignedUrl(document.fileUrl, 3600);

  return { document, fields, pdfUrl };
};

const saveFieldInputSchema = z.object({
  documentId: z.string().uuid(),
  fields: z.array(
    z.object({
      type: z.nativeEnum(SignatureFieldType),
      x: z.number(),
      y: z.number(),
      page: z.number().int().min(1),
    }),
  ),
});

type SaveFieldInput = z.infer<typeof saveFieldInputSchema>;

export const saveFields: SaveFields<SaveFieldInput, { count: number }> = async (
  rawArgs,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const args = ensureArgsSchemaOrThrowHttpError(
    saveFieldInputSchema,
    rawArgs,
  );

  const doc = await context.entities.Document.findFirst({
    where: { id: args.documentId, userId: context.user.id },
  });

  if (!doc) {
    throw new HttpError(404, "Document not found.");
  }

  if (doc.status !== DocumentStatus.DRAFT) {
    throw new HttpError(400, "Only draft documents can be edited.");
  }

  await prisma.$transaction([
    prisma.signatureField.deleteMany({
      where: { documentId: doc.id },
    }),
    prisma.signatureField.createMany({
      data: args.fields.map((f) => ({
        id: randomUUID(),
        type: f.type,
        xPos: f.x,
        yPos: f.y,
        pageNumber: f.page,
        documentId: doc.id,
      })),
    }),
  ]);

  return { count: args.fields.length };
};

const saveSignatureImageInputSchema = z.object({
  imageBase64: z.string().min(1),
});

type SaveSignatureImageInput = z.infer<typeof saveSignatureImageInputSchema>;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPngBuffer(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

export const sendDocument: SendDocument<
  z.infer<typeof documentIdSchema>,
  Document
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { documentId } = ensureArgsSchemaOrThrowHttpError(
    documentIdSchema,
    rawArgs,
  );

  const doc = await context.entities.Document.findFirst({
    where: { id: documentId, userId: context.user.id },
  });

  if (!doc) {
    throw new HttpError(404, "Document not found.");
  }

  if (doc.status !== DocumentStatus.DRAFT) {
    throw new HttpError(400, "Only draft documents can be sent.");
  }

  return context.entities.Document.update({
    where: { id: documentId },
    data: { status: DocumentStatus.SENT },
  });
};

export const deleteDocument: DeleteDocument<
  z.infer<typeof documentIdSchema>,
  Document
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { documentId } = ensureArgsSchemaOrThrowHttpError(
    documentIdSchema,
    rawArgs,
  );

  const doc = await context.entities.Document.findFirst({
    where: { id: documentId, userId: context.user.id },
  });

  if (!doc) {
    throw new HttpError(404, "Document not found.");
  }

  return context.entities.Document.delete({
    where: { id: documentId },
  });
};

export const saveSignatureImage: SaveSignatureImage<
  SaveSignatureImageInput,
  SignatureImage
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const args = ensureArgsSchemaOrThrowHttpError(
    saveSignatureImageInputSchema,
    rawArgs,
  );

  let buffer: Buffer;
  try {
    buffer = Buffer.from(args.imageBase64, "base64");
  } catch {
    throw new HttpError(400, "Invalid image data.");
  }

  if (buffer.length === 0) {
    throw new HttpError(400, "Empty image.");
  }
  if (buffer.length > MAX_SIGNATURE_BYTES) {
    throw new HttpError(400, "Image is too large.");
  }
  if (!isPngBuffer(buffer)) {
    throw new HttpError(400, "Signature must be a PNG image.");
  }

  const objectKey = `${context.user.id}/signatures/${randomUUID()}.png`;

  await uploadFile({
    objectKey,
    data: buffer,
    contentType: "image/png",
  });

  return context.entities.SignatureImage.create({
    data: {
      imageUrl: objectKey,
      user: { connect: { id: context.user.id } },
    },
  });
};
