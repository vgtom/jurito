import {
  DocumentStatus,
  Prisma,
  SignatureFieldType,
  UserPlan,
} from "@prisma/client";
import { randomUUID } from "crypto";
import * as path from "path";
import {
  type Document,
  type DocumentFolder,
  type DocumentParty,
  type SignatureField,
  type SignatureImage,
} from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import {
  type AddDocumentParty,
  type AppendPdfToTemplate,
  type CreateDocument,
  type CreateFolder,
  type DeleteDocument,
  type GetDocumentForEditor,
  type GetDocumentSubmissions,
  type GetDocuments,
  type GetFolders,
  type MoveDocumentToFolder,
  type RemoveDocumentParty,
  type SaveSignatureImage,
  type SaveFields,
  type SendDocument,
  type UpdateDocumentParty,
} from "wasp/server/operations";
import * as z from "zod";

import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import { getPresignedUrl, uploadFile } from "./objectStorage";

const PDF_MAGIC = Buffer.from("%PDF");

const MAX_PDF_BYTES = 20 * 1024 * 1024;

const DEFAULT_TEMPLATE_FOLDER_NAME = "MyFolder";

async function getOrCreateMyFolder(userId: string): Promise<string> {
  const existing = await prisma.documentFolder.findUnique({
    where: {
      userId_name: { userId, name: DEFAULT_TEMPLATE_FOLDER_NAME },
    },
  });
  if (existing) return existing.id;
  const created = await prisma.documentFolder.create({
    data: { userId, name: DEFAULT_TEMPLATE_FOLDER_NAME },
  });
  return created.id;
}

const createDocumentInputSchema = z.object({
  fileName: z.string().min(1).max(512),
  fileBase64: z.string().min(1),
  contentType: z.literal("application/pdf").optional(),
  folderId: z.string().uuid().optional(),
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

  let resolvedFolderId: string;
  if (args.folderId) {
    const folder = await prisma.documentFolder.findFirst({
      where: { id: args.folderId, userId: context.user.id },
    });
    if (!folder) {
      throw new HttpError(400, "Invalid folder.");
    }
    resolvedFolderId = folder.id;
  } else {
    resolvedFolderId = await getOrCreateMyFolder(context.user.id);
  }

  return context.entities.Document.create({
    data: {
      name: safeBase || "document.pdf",
      fileUrl: objectKey,
      status: DocumentStatus.DRAFT,
      user: { connect: { id: context.user.id } },
      folder: { connect: { id: resolvedFolderId } },
      parties: {
        create: {
          sortOrder: 0,
          label: "First party",
        },
      },
    },
  });
};

export type DocumentWithFolder = Document & { folder: DocumentFolder };

export const getDocuments: GetDocuments<void, DocumentWithFolder[]> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  return prisma.document.findMany({
    where: { userId: context.user.id },
    include: { folder: true },
    orderBy: { createdAt: "desc" },
  });
};

export const getFolders: GetFolders<void, DocumentFolder[]> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  return prisma.documentFolder.findMany({
    where: { userId: context.user.id },
    orderBy: { name: "asc" },
  });
};

export const getDocumentSubmissions: GetDocumentSubmissions<
  void,
  Document[]
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  return prisma.document.findMany({
    where: {
      userId: context.user.id,
      status: { in: [DocumentStatus.SENT, DocumentStatus.SIGNED] },
    },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
  });
};

const createFolderInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
});

export const createFolder: CreateFolder<
  z.infer<typeof createFolderInputSchema>,
  DocumentFolder
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { name: raw } = ensureArgsSchemaOrThrowHttpError(
    createFolderInputSchema,
    rawArgs,
  );
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length === 0) {
    throw new HttpError(400, "Folder name is required.");
  }

  try {
    return await prisma.documentFolder.create({
      data: { userId: context.user.id, name },
    });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new HttpError(409, "A folder with that name already exists.");
    }
    throw e;
  }
};

const moveDocumentToFolderInputSchema = z.object({
  documentId: z.string().uuid(),
  folderId: z.string().uuid(),
});

export const moveDocumentToFolder: MoveDocumentToFolder<
  z.infer<typeof moveDocumentToFolderInputSchema>,
  Document
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const args = ensureArgsSchemaOrThrowHttpError(
    moveDocumentToFolderInputSchema,
    rawArgs,
  );

  const doc = await context.entities.Document.findFirst({
    where: { id: args.documentId, userId: context.user.id },
  });

  if (!doc) {
    throw new HttpError(404, "Document not found.");
  }

  const folder = await prisma.documentFolder.findFirst({
    where: { id: args.folderId, userId: context.user.id },
  });

  if (!folder) {
    throw new HttpError(404, "Folder not found.");
  }

  return context.entities.Document.update({
    where: { id: doc.id },
    data: { folderId: folder.id },
  });
};

const documentIdSchema = z.object({
  documentId: z.string().uuid(),
});

/** One PDF in the template: base document or an appended part (presigned GET URL). */
export type PdfPart = {
  partId: string;
  label: string;
  presignedUrl: string;
};

export type DocumentForEditorPayload = {
  document: Document;
  fields: SignatureField[];
  parts: PdfPart[];
  parties: DocumentParty[];
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

  const appends = await prisma.documentAppend.findMany({
    where: { documentId: document.id },
    orderBy: { sortOrder: "asc" },
  });

  const baseUrl = await getPresignedUrl(document.fileUrl, 3600);
  const appendParts: PdfPart[] = await Promise.all(
    appends.map(async (a, idx) => ({
      partId: a.id,
      label: `Append ${idx + 1}`,
      presignedUrl: await getPresignedUrl(a.fileUrl, 3600),
    })),
  );

  const parts: PdfPart[] = [
    {
      partId: `base:${document.id}`,
      label: document.name,
      presignedUrl: baseUrl,
    },
    ...appendParts,
  ];

  const parties = await prisma.documentParty.findMany({
    where: { documentId: document.id },
    orderBy: { sortOrder: "asc" },
  });

  return { document, fields, parts, parties };
};

function partyLabelForSortOrder(sortOrder: number): string {
  const names = [
    "First party",
    "Second party",
    "Third party",
    "Fourth party",
    "Fifth party",
    "Sixth party",
    "Seventh party",
    "Eighth party",
    "Ninth party",
    "Tenth party",
  ];
  return names[sortOrder] ?? `${sortOrder + 1}th party`;
}

export const addDocumentParty: AddDocumentParty<
  z.infer<typeof documentIdSchema>,
  DocumentParty
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
    throw new HttpError(400, "Only draft documents can be edited.");
  }

  const last = await prisma.documentParty.findFirst({
    where: { documentId: doc.id },
    orderBy: { sortOrder: "desc" },
  });
  const nextOrder = (last?.sortOrder ?? -1) + 1;

  return prisma.documentParty.create({
    data: {
      documentId: doc.id,
      sortOrder: nextOrder,
      label: partyLabelForSortOrder(nextOrder),
    },
  });
};

const appendPdfToTemplateSchema = z.object({
  templateDocumentId: z.string().uuid(),
  fileName: z.string().min(1).max(512),
  fileBase64: z.string().min(1),
  contentType: z.literal("application/pdf").optional(),
});

export const appendPdfToTemplate: AppendPdfToTemplate<
  z.infer<typeof appendPdfToTemplateSchema>,
  { id: string }
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const args = ensureArgsSchemaOrThrowHttpError(
    appendPdfToTemplateSchema,
    rawArgs,
  );

  const template = await context.entities.Document.findFirst({
    where: { id: args.templateDocumentId, userId: context.user.id },
  });

  if (!template) {
    throw new HttpError(404, "Document not found.");
  }

  if (template.status !== DocumentStatus.DRAFT) {
    throw new HttpError(400, "Only draft templates can be edited.");
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

  const last = await prisma.documentAppend.findFirst({
    where: { documentId: template.id },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const nextOrder = (last?.sortOrder ?? -1) + 1;

  const row = await prisma.documentAppend.create({
    data: {
      documentId: template.id,
      fileUrl: objectKey,
      sortOrder: nextOrder,
    },
  });

  return { id: row.id };
};

const updateDocumentPartySchema = z.object({
  documentId: z.string().uuid(),
  partyId: z.string().uuid(),
  label: z.string().trim().min(1).max(128),
});

export const updateDocumentParty: UpdateDocumentParty<
  z.infer<typeof updateDocumentPartySchema>,
  DocumentParty
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const args = ensureArgsSchemaOrThrowHttpError(
    updateDocumentPartySchema,
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

  const party = await prisma.documentParty.findFirst({
    where: { id: args.partyId, documentId: doc.id },
  });

  if (!party) {
    throw new HttpError(404, "Party not found.");
  }

  return prisma.documentParty.update({
    where: { id: party.id },
    data: { label: args.label.trim().replace(/\s+/g, " ") },
  });
};

const removeDocumentPartySchema = z.object({
  documentId: z.string().uuid(),
  partyId: z.string().uuid(),
});

export const removeDocumentParty: RemoveDocumentParty<
  z.infer<typeof removeDocumentPartySchema>,
  { id: string }
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { documentId, partyId } = ensureArgsSchemaOrThrowHttpError(
    removeDocumentPartySchema,
    rawArgs,
  );

  const doc = await context.entities.Document.findFirst({
    where: { id: documentId, userId: context.user.id },
  });

  if (!doc) {
    throw new HttpError(404, "Document not found.");
  }

  if (doc.status !== DocumentStatus.DRAFT) {
    throw new HttpError(400, "Only draft documents can be edited.");
  }

  const count = await prisma.documentParty.count({
    where: { documentId: doc.id },
  });

  if (count <= 1) {
    throw new HttpError(400, "Cannot delete the only party on this document.");
  }

  const party = await prisma.documentParty.findFirst({
    where: { id: partyId, documentId: doc.id },
  });

  if (!party) {
    throw new HttpError(404, "Party not found.");
  }

  await prisma.documentParty.delete({
    where: { id: party.id },
  });

  return { id: party.id };
};

const saveFieldInputSchema = z.object({
  documentId: z.string().uuid(),
  fields: z.array(
    z.object({
      type: z.nativeEnum(SignatureFieldType),
      x: z.number(),
      y: z.number(),
      page: z.number().int().min(1),
      documentPartyId: z.string().uuid(),
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

  const partyRows = await prisma.documentParty.findMany({
    where: { documentId: doc.id },
    select: { id: true },
  });
  const allowedPartyIds = new Set(partyRows.map((p) => p.id));
  for (const f of args.fields) {
    if (!allowedPartyIds.has(f.documentPartyId)) {
      throw new HttpError(400, "Invalid party for this document.");
    }
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
        documentPartyId: f.documentPartyId,
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
    data: {
      status: DocumentStatus.SENT,
      sentAt: new Date(),
    },
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
