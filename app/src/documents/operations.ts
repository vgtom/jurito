import {
  DocumentStatus,
  PartySigningStatus,
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
import { emailSender } from "wasp/server/email";
import { HttpError, prisma } from "wasp/server";
import {
  type AddDocumentParty,
  type AppendPdfToTemplate,
  type CreateDocument,
  type CreateFolder,
  type DeleteDocument,
  type DuplicateDocument,
  type GetDocumentForEditor,
  type GetDocumentSubmissions,
  type GetDocuments,
  type GetFolders,
  type GetSigningContacts,
  type MoveDocumentToFolder,
  type RemoveDocumentParty,
  type SaveSignatureImage,
  type SaveFields,
  type SendDocument,
  type UpdateDocumentParty,
} from "wasp/server/operations";
import * as z from "zod";

import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import { downloadObjectBuffer, getPresignedUrl, uploadFile } from "./objectStorage";

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

/** Submissions tab: per-party line for signing pipeline (email → open → sign / decline). */
export type DocumentSubmissionPartyRow = {
  id: string;
  label: string;
  sortOrder: number;
  signingStatus: PartySigningStatus;
  statusSummary: string;
};

export type DocumentSubmissionRow = {
  id: string;
  name: string;
  status: DocumentStatus;
  sentAt: Date | null;
  createdAt: Date;
  preserveSigningOrder: boolean;
  parties: DocumentSubmissionPartyRow[];
};

function buildSubmissionPartySummary(
  p: {
    label: string;
    signingStatus: PartySigningStatus;
    inviteSentAt: Date | null;
    signingViewedAt: Date | null;
    rejectedAt: Date | null;
  },
  ctx: { preserveSigningOrder: boolean },
): string {
  const label = p.label.trim() || "Signer";
  if (p.signingStatus === PartySigningStatus.REJECTED || p.rejectedAt) {
    return `${label}: Declined to sign`;
  }
  if (p.signingStatus === PartySigningStatus.COMPLETED) {
    return `${label}: Signed`;
  }
  if (p.signingStatus === PartySigningStatus.NOT_SENT) {
    if (ctx.preserveSigningOrder) {
      return `${label}: Waiting for previous signers`;
    }
    return `${label}: Not invited`;
  }
  if (!p.inviteSentAt) {
    return `${label}: Awaiting signature`;
  }
  if (!p.signingViewedAt) {
    return `${label}: Email sent — link not opened yet`;
  }
  return `${label}: Opened — awaiting signature`;
}

export const getDocumentSubmissions: GetDocumentSubmissions<
  void,
  DocumentSubmissionRow[]
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const docs = await prisma.document.findMany({
    where: {
      userId: context.user.id,
      status: { in: [DocumentStatus.SENT, DocumentStatus.SIGNED] },
    },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    include: {
      parties: { orderBy: { sortOrder: "asc" } },
    },
  });

  return docs.map((doc) => ({
    id: doc.id,
    name: doc.name,
    status: doc.status,
    sentAt: doc.sentAt,
    createdAt: doc.createdAt,
    preserveSigningOrder: doc.preserveSigningOrder,
    parties: doc.parties.map((p) => ({
      id: p.id,
      label: p.label,
      sortOrder: p.sortOrder,
      signingStatus: p.signingStatus,
      statusSummary: buildSubmissionPartySummary(p, {
        preserveSigningOrder: doc.preserveSigningOrder,
      }),
    })),
  }));
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
    orderBy: [{ documentPartyId: "asc" }, { placementOrder: "asc" }, { pageNumber: "asc" }],
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
      placementOrder: z.number().int().min(0),
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
        placementOrder: f.placementOrder,
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

function getClientBaseUrl(): string {
  const raw = process.env.WASP_WEB_CLIENT_URL ?? "http://localhost:3000";
  return raw.replace(/\/$/, "");
}

function normalizeContactEmail(email: string): string {
  return email.trim().toLowerCase();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function upsertUserContacts(
  userId: string,
  entries: { name: string; email: string }[],
): Promise<void> {
  for (const e of entries) {
    const email = normalizeContactEmail(e.email);
    const name = e.name.trim();
    if (!name || !email) continue;
    await prisma.userContact.upsert({
      where: {
        userId_email: { userId, email },
      },
      create: {
        userId,
        name,
        email,
      },
      update: {
        name,
      },
    });
  }
}

async function sendSigningInviteEmail(params: {
  to: string;
  signerName: string;
  documentName: string;
  signUrl: string;
}): Promise<void> {
  const { to, signerName, documentName, signUrl } = params;
  await emailSender.send({
    to,
    subject: `Please sign: ${documentName}`,
    text: `Hi ${signerName},\n\nPlease review and sign "${documentName}".\n\n${signUrl}\n`,
    html: `<p>Hi ${escapeHtml(signerName)},</p><p>Please review and sign <strong>${escapeHtml(documentName)}</strong>.</p><p><a href="${escapeHtml(signUrl)}">Open signing page</a></p>`,
  });
}

async function maybeMarkDocumentFullySigned(documentId: string): Promise<void> {
  const pending = await prisma.documentParty.count({
    where: {
      documentId,
      signingStatus: { not: PartySigningStatus.COMPLETED },
    },
  });
  if (pending === 0) {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: DocumentStatus.SIGNED },
    });
  }
}

const sendDocumentInputSchema = z.object({
  documentId: z.string().uuid(),
  preserveSigningOrder: z.boolean(),
  parties: z
    .array(
      z.object({
        partyId: z.string().uuid(),
        signerName: z.string().min(1).max(200),
        signerEmail: z.string().email(),
      }),
    )
    .min(1),
});

export const sendDocument: SendDocument<
  z.infer<typeof sendDocumentInputSchema>,
  Document
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const args = ensureArgsSchemaOrThrowHttpError(
    sendDocumentInputSchema,
    rawArgs,
  );

  const doc = await context.entities.Document.findFirst({
    where: { id: args.documentId, userId: context.user.id },
  });

  if (!doc) {
    throw new HttpError(404, "Document not found.");
  }

  if (doc.status !== DocumentStatus.DRAFT) {
    throw new HttpError(400, "Only draft documents can be sent.");
  }

  const existingParties = await prisma.documentParty.findMany({
    where: { documentId: doc.id },
    orderBy: { sortOrder: "asc" },
  });

  if (existingParties.length !== args.parties.length) {
    throw new HttpError(400, "Provide signer details for every party.");
  }

  const byId = new Map(args.parties.map((p) => [p.partyId, p]));
  for (const ep of existingParties) {
    if (!byId.has(ep.id)) {
      throw new HttpError(400, "Each party must have signer name and email.");
    }
  }

  await upsertUserContacts(
    context.user.id,
    args.parties.map((p) => ({
      name: p.signerName,
      email: normalizeContactEmail(p.signerEmail),
    })),
  );

  const baseUrl = getClientBaseUrl();

  if (args.preserveSigningOrder) {
    const first = existingParties[0]!;
    const firstPayload = byId.get(first.id)!;
    const firstToken = randomUUID();

    await prisma.$transaction([
      prisma.document.update({
        where: { id: doc.id },
        data: {
          status: DocumentStatus.SENT,
          sentAt: new Date(),
          preserveSigningOrder: true,
        },
      }),
      ...existingParties.map((ep, idx) => {
        const row = byId.get(ep.id)!;
        const email = normalizeContactEmail(row.signerEmail);
        if (idx === 0) {
          return prisma.documentParty.update({
            where: { id: ep.id },
            data: {
              signerName: row.signerName.trim(),
              signerEmail: email,
              signingToken: firstToken,
              signingStatus: PartySigningStatus.AWAITING_SIGNATURE,
              inviteSentAt: new Date(),
            },
          });
        }
        return prisma.documentParty.update({
          where: { id: ep.id },
          data: {
            signerName: row.signerName.trim(),
            signerEmail: email,
            signingToken: null,
            signingStatus: PartySigningStatus.NOT_SENT,
            inviteSentAt: null,
            signingViewedAt: null,
            rejectedAt: null,
          },
        });
      }),
    ]);

    const signUrl = `${baseUrl}/sign/${firstToken}`;
    await sendSigningInviteEmail({
      to: normalizeContactEmail(firstPayload.signerEmail),
      signerName: firstPayload.signerName.trim(),
      documentName: doc.name,
      signUrl,
    });
  } else {
    const tokens = existingParties.map(() => randomUUID());

    await prisma.$transaction([
      prisma.document.update({
        where: { id: doc.id },
        data: {
          status: DocumentStatus.SENT,
          sentAt: new Date(),
          preserveSigningOrder: false,
        },
      }),
      ...existingParties.map((ep, idx) => {
        const row = byId.get(ep.id)!;
        const email = normalizeContactEmail(row.signerEmail);
        return prisma.documentParty.update({
          where: { id: ep.id },
          data: {
            signerName: row.signerName.trim(),
            signerEmail: email,
            signingToken: tokens[idx]!,
            signingStatus: PartySigningStatus.AWAITING_SIGNATURE,
            inviteSentAt: new Date(),
          },
        });
      }),
    ]);

    for (let i = 0; i < existingParties.length; i++) {
      const ep = existingParties[i]!;
      const row = byId.get(ep.id)!;
      const signUrl = `${baseUrl}/sign/${tokens[i]}`;
      await sendSigningInviteEmail({
        to: normalizeContactEmail(row.signerEmail),
        signerName: row.signerName.trim(),
        documentName: doc.name,
        signUrl,
      });
    }
  }

  return context.entities.Document.findUniqueOrThrow({
    where: { id: doc.id },
  });
};

export const getSigningContacts: GetSigningContacts<
  void,
  { id: string; name: string; email: string }[]
> = async (_args, context) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  return prisma.userContact.findMany({
    where: { userId: context.user.id },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true, name: true, email: true },
  });
};

const signingTokenParamSchema = z.object({
  token: z.string().min(16),
});

export type SigningFieldPayload = {
  id: string;
  type: SignatureFieldType;
  xPos: number;
  yPos: number;
  pageNumber: number;
  placementOrder: number;
  documentPartyId: string;
  partyLabel: string;
};

/** Saved answers already stored for this document (any party). Anonymous signers load these via token — no login. */
export type SigningSavedFieldValue = {
  fieldId: string;
  documentPartyId: string;
  textValue: string | null;
  imagePresignedUrl: string | null;
};

export type SigningInvitePayload = {
  documentName: string;
  partyLabel: string;
  signerName: string;
  signerEmail: string | null;
  documentPartyId: string;
  documentId: string;
  inviterEmail: string | null;
  parts: PdfPart[];
  fields: SigningFieldPayload[];
  /** Submitted values for fields on this document (e.g. earlier signers in order). */
  savedFieldValues: SigningSavedFieldValue[];
};

/**
 * Public signing payload (no login). The opaque `token` identifies the party row;
 * template `fields` and any `savedFieldValues` come from DB so signers never need a User account.
 */
export async function lookupSigningInviteByToken(
  token: string,
): Promise<SigningInvitePayload | null> {
  const parsed = signingTokenParamSchema.safeParse({ token });
  if (!parsed.success) {
    return null;
  }

  const party = await prisma.documentParty.findFirst({
    where: {
      signingToken: parsed.data.token,
      signingStatus: PartySigningStatus.AWAITING_SIGNATURE,
    },
    include: {
      document: {
        include: {
          user: { select: { email: true } },
        },
      },
    },
  });

  if (!party) {
    return null;
  }

  if (!party.signingViewedAt) {
    await prisma.documentParty.update({
      where: { id: party.id },
      data: { signingViewedAt: new Date() },
    });
  }

  const document = party.document;
  const appends = await prisma.documentAppend.findMany({
    where: { documentId: document.id },
    orderBy: { sortOrder: "asc" },
  });

  const parties = await prisma.documentParty.findMany({
    where: { documentId: document.id },
    orderBy: { sortOrder: "asc" },
  });
  const labelByPartyId = Object.fromEntries(
    parties.map((p) => [p.id, p.label]),
  );

  const fields = await prisma.signatureField.findMany({
    where: { documentId: document.id },
    orderBy: [{ documentPartyId: "asc" }, { placementOrder: "asc" }, { pageNumber: "asc" }, { id: "asc" }],
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

  const completionRows = await prisma.signatureFieldCompletion.findMany({
    where: {
      documentParty: { documentId: document.id },
    },
  });

  const savedFieldValues: SigningSavedFieldValue[] = await Promise.all(
    completionRows.map(async (c) => {
      let imagePresignedUrl: string | null = null;
      if (c.imageObjectKey) {
        imagePresignedUrl = await getPresignedUrl(c.imageObjectKey, 3600);
      }
      return {
        fieldId: c.signatureFieldId,
        documentPartyId: c.documentPartyId,
        textValue: c.textValue,
        imagePresignedUrl,
      };
    }),
  );

  return {
    documentName: document.name,
    partyLabel: party.label,
    signerName: party.signerName?.trim() || party.label,
    signerEmail: party.signerEmail,
    documentPartyId: party.id,
    documentId: document.id,
    inviterEmail: document.user?.email ?? null,
    parts,
    fields: fields.map((f) => ({
      id: f.id,
      type: f.type,
      xPos: f.xPos,
      yPos: f.yPos,
      pageNumber: f.pageNumber,
      placementOrder: f.placementOrder,
      documentPartyId: f.documentPartyId,
      partyLabel: labelByPartyId[f.documentPartyId] ?? "",
    })),
    savedFieldValues,
  };
}

function fieldUsesImageStorage(type: SignatureFieldType): boolean {
  return (
    type === SignatureFieldType.SIGNATURE || type === SignatureFieldType.IMAGE
  );
}

const signingCompleteBodySchema = z.object({
  completions: z
    .array(
      z.object({
        fieldId: z.string().uuid(),
        textValue: z.string().optional(),
        imageBase64: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
});

function decodeBase64ImagePayload(raw: string): Buffer {
  const trimmed = raw.trim();
  const base64 = trimmed.includes(",")
    ? trimmed.split(",", 2)[1]!
    : trimmed;
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    throw new HttpError(400, "Invalid image data.");
  }
  if (buf.length === 0) {
    throw new HttpError(400, "Empty image.");
  }
  if (buf.length > MAX_SIGNATURE_BYTES) {
    throw new HttpError(400, "Image is too large.");
  }
  if (!isPngBuffer(buf)) {
    throw new HttpError(400, "Signature image must be PNG.");
  }
  return buf;
}

/** Public decline flow (no auth). Invalidates the signing link and records rejection. */
export async function rejectSigningByToken(
  token: string,
): Promise<{ ok: boolean; message: string }> {
  const parsed = signingTokenParamSchema.safeParse({ token });
  if (!parsed.success) {
    throw new HttpError(400, "Invalid signing link.");
  }

  const party = await prisma.documentParty.findFirst({
    where: {
      signingToken: parsed.data.token,
      signingStatus: PartySigningStatus.AWAITING_SIGNATURE,
    },
  });

  if (!party) {
    throw new HttpError(400, "Invalid or expired signing link.");
  }

  await prisma.documentParty.update({
    where: { id: party.id },
    data: {
      signingStatus: PartySigningStatus.REJECTED,
      signingToken: null,
      rejectedAt: new Date(),
    },
  });

  return {
    ok: true,
    message: "You have declined to sign this document.",
  };
}

/** Used by the public signing HTTP API (no auth). */
export async function finalizePartySigningByToken(
  token: string,
  rawBody?: unknown,
): Promise<{ ok: boolean; message: string }> {
  const parsed = signingTokenParamSchema.safeParse({ token });
  if (!parsed.success) {
    throw new HttpError(400, "Invalid signing link.");
  }

  const party = await prisma.documentParty.findFirst({
    where: { signingToken: parsed.data.token },
    include: {
      document: {
        include: {
          parties: { orderBy: { sortOrder: "asc" } },
        },
      },
    },
  });

  if (!party || party.signingStatus !== PartySigningStatus.AWAITING_SIGNATURE) {
    throw new HttpError(400, "Invalid or expired signing link.");
  }

  const myFields = await prisma.signatureField.findMany({
    where: { documentId: party.documentId, documentPartyId: party.id },
    orderBy: [{ placementOrder: "asc" }, { pageNumber: "asc" }, { id: "asc" }],
  });

  if (myFields.length > 0) {
    const bodyParsed = signingCompleteBodySchema.safeParse(rawBody ?? {});
    if (!bodyParsed.success) {
      throw new HttpError(400, "Invalid request body.");
    }
    const { completions } = bodyParsed.data;
    const byFieldId = new Map(completions.map((c) => [c.fieldId, c]));
    const ownerUserId = party.document.userId;

    for (const f of myFields) {
      const c = byFieldId.get(f.id);
      if (!c) {
        throw new HttpError(
          400,
          `Missing value for a required field (${f.type} on page ${f.pageNumber}).`,
        );
      }
      if (fieldUsesImageStorage(f.type)) {
        if (!c.imageBase64?.trim()) {
          throw new HttpError(
            400,
            `Missing image for ${f.type} field on page ${f.pageNumber}.`,
          );
        }
        const buf = decodeBase64ImagePayload(c.imageBase64);
        const key = `${ownerUserId}/signing/${party.documentId}/${party.id}/${f.id}.png`;
        await uploadFile({
          objectKey: key,
          data: buf,
          contentType: "image/png",
        });
        await prisma.signatureFieldCompletion.upsert({
          where: {
            signatureFieldId_documentPartyId: {
              signatureFieldId: f.id,
              documentPartyId: party.id,
            },
          },
          create: {
            signatureFieldId: f.id,
            documentPartyId: party.id,
            imageObjectKey: key,
          },
          update: {
            textValue: null,
            imageObjectKey: key,
          },
        });
      } else {
        const text = c.textValue?.trim();
        if (!text) {
          throw new HttpError(
            400,
            `Missing text for ${f.type} field on page ${f.pageNumber}.`,
          );
        }
        await prisma.signatureFieldCompletion.upsert({
          where: {
            signatureFieldId_documentPartyId: {
              signatureFieldId: f.id,
              documentPartyId: party.id,
            },
          },
          create: {
            signatureFieldId: f.id,
            documentPartyId: party.id,
            textValue: text,
          },
          update: {
            textValue: text,
            imageObjectKey: null,
          },
        });
      }
    }
  }

  const documentId = party.documentId;
  const doc = party.document;
  const ordered = doc.parties;

  await prisma.documentParty.update({
    where: { id: party.id },
    data: {
      signingStatus: PartySigningStatus.COMPLETED,
      signingToken: null,
    },
  });

  await maybeMarkDocumentFullySigned(documentId);

  if (doc.preserveSigningOrder) {
    const idx = ordered.findIndex((p) => p.id === party.id);
    const nextParty = ordered[idx + 1];
    if (nextParty && nextParty.signingStatus === PartySigningStatus.NOT_SENT) {
      const newToken = randomUUID();
      const nextRow = await prisma.documentParty.update({
        where: { id: nextParty.id },
        data: {
          signingToken: newToken,
          signingStatus: PartySigningStatus.AWAITING_SIGNATURE,
          inviteSentAt: new Date(),
        },
      });
      const baseUrl = getClientBaseUrl();
      const signUrl = `${baseUrl}/sign/${newToken}`;
      const to = nextRow.signerEmail;
      const name = nextRow.signerName?.trim() ?? nextParty.label;
      if (to) {
        await sendSigningInviteEmail({
          to: normalizeContactEmail(to),
          signerName: name,
          documentName: doc.name,
          signUrl,
        });
      }
    }
  }

  return { ok: true, message: "Signing recorded. Thank you." };
}

function duplicateDocumentDisplayName(original: string): string {
  const max = 500;
  const base =
    original.length > max ? `${original.slice(0, max - 1)}…` : original;
  if (/\.pdf$/i.test(base)) {
    return base.replace(/\.pdf$/i, " copy.pdf");
  }
  return `${base} (copy)`;
}

async function copyStoredPdfToNewKey(
  sourceKey: string,
  userId: string,
): Promise<string> {
  const buf = await downloadObjectBuffer(sourceKey);
  const ext = path.extname(sourceKey) || ".pdf";
  const objectKey = `${userId}/${randomUUID()}${ext}`;
  await uploadFile({
    objectKey,
    data: buf,
    contentType: "application/pdf",
  });
  return objectKey;
}

export const duplicateDocument: DuplicateDocument<
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
      "Free plan allows one document. Upgrade to Pro to duplicate or add more templates.",
    );
  }

  const source = await prisma.document.findFirst({
    where: { id: documentId, userId: context.user.id },
    include: {
      parties: { orderBy: { sortOrder: "asc" } },
      signatureFields: true,
      appends: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!source) {
    throw new HttpError(404, "Document not found.");
  }

  const newName = duplicateDocumentDisplayName(source.name);
  const userId = context.user.id;

  const newBaseKey = await copyStoredPdfToNewKey(source.fileUrl, userId);
  const newAppendKeys: string[] = [];
  for (const a of source.appends) {
    newAppendKeys.push(await copyStoredPdfToNewKey(a.fileUrl, userId));
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.document.create({
      data: {
        name: newName,
        fileUrl: newBaseKey,
        status: DocumentStatus.DRAFT,
        sentAt: null,
        preserveSigningOrder: false,
        userId,
        folderId: source.folderId,
        parties: {
          create: source.parties.map((p) => ({
            sortOrder: p.sortOrder,
            label: p.label,
            signerName: null,
            signerEmail: null,
            signingToken: null,
            signingStatus: PartySigningStatus.NOT_SENT,
          })),
        },
      },
      include: {
        parties: { orderBy: { sortOrder: "asc" } },
      },
    });

    const newParties = created.parties;
    if (newParties.length !== source.parties.length) {
      throw new HttpError(500, "Duplicate failed: party mismatch.");
    }

    const partyMap = new Map<string, string>();
    for (let i = 0; i < source.parties.length; i++) {
      partyMap.set(source.parties[i]!.id, newParties[i]!.id);
    }

    for (let i = 0; i < source.appends.length; i++) {
      await tx.documentAppend.create({
        data: {
          documentId: created.id,
          sortOrder: source.appends[i]!.sortOrder,
          fileUrl: newAppendKeys[i]!,
        },
      });
    }

    for (const f of source.signatureFields) {
      const newPartyId = partyMap.get(f.documentPartyId);
      if (!newPartyId) {
        throw new HttpError(500, "Duplicate failed: unknown party on field.");
      }
      await tx.signatureField.create({
        data: {
          type: f.type,
          xPos: f.xPos,
          yPos: f.yPos,
          pageNumber: f.pageNumber,
          placementOrder: f.placementOrder,
          documentId: created.id,
          documentPartyId: newPartyId,
        },
      });
    }

    return tx.document.findUniqueOrThrow({
      where: { id: created.id },
    });
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
