import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useAuth } from "wasp/client/auth";
import {
  addDocumentParty,
  appendPdfToTemplate,
  getDocumentForEditor,
  removeDocumentParty,
  saveFields,
  sendDocument,
  updateDocumentParty,
  useQuery,
} from "wasp/client/operations";
import { Link, routes } from "wasp/client/router";
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  Eye,
  FilePlus,
  Loader2,
  PenLine,
  Plus,
  Save,
  Send,
  Settings2,
  Trash2,
  Type,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Rnd } from "react-rnd";
import { useNavigate, useParams } from "react-router-dom";

import { PremiumFeature } from "../client/components/billing/PremiumFeature";
import { Button } from "../client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../client/components/ui/dropdown-menu";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../client/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../client/components/ui/dialog";
import { Input } from "../client/components/ui/input";
import { Label } from "../client/components/ui/label";
import { toast } from "../client/hooks/use-toast";
import { cn } from "../client/utils";
import { SignaturePad } from "./SignaturePad";

/** Mirrors server `PdfPart` from `getDocumentForEditor` — keep in sync. */
type PdfPart = {
  partId: string;
  label: string;
  presignedUrl: string;
};

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Matches Prisma `SignatureFieldType` — avoid importing `@prisma/client` in client bundles. */
const SignatureFieldType = {
  SIGNATURE: "SIGNATURE",
  INITIALS: "INITIALS",
  DATE: "DATE",
} as const;

type SignatureFieldTypeValue =
  (typeof SignatureFieldType)[keyof typeof SignatureFieldType];

function fieldTypeTitle(t: SignatureFieldTypeValue): string {
  if (t === SignatureFieldType.SIGNATURE) return "Signature";
  if (t === SignatureFieldType.INITIALS) return "Initials";
  return "Date";
}

function fieldRowLabel(f: EditorField): string {
  return `${fieldTypeTitle(f.type)} · page ${f.page}`;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

const BOX_W = 140;
const BOX_H = 48;

export type EditorField = {
  key: string;
  type: SignatureFieldTypeValue;
  /** Normalized 0–1, top-left of placement box */
  xNorm: number;
  yNorm: number;
  /** 1-based global page index across base + appends */
  page: number;
  documentPartyId: string;
  /** Shown on fields when document is sent (all parties visible). */
  partyLabel?: string;
};

function FieldOverlayLayer({
  pageIndex,
  pageWidth,
  pageHeight,
  fields,
  readOnly,
  onPositionChange,
}: {
  /** 0-based global page index */
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  fields: EditorField[];
  readOnly: boolean;
  onPositionChange: (key: string, xNorm: number, yNorm: number) => void;
}) {
  const pageNum = pageIndex + 1;
  const pageFields = fields.filter((f) => f.page === pageNum);

  return (
    <div
      className="pointer-events-none"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: pageWidth,
        height: pageHeight,
        zIndex: 2,
      }}
    >
      <div
        className="relative h-full w-full"
        style={{ pointerEvents: readOnly ? "none" : "auto" }}
      >
        {pageFields.map((f) => (
          <Rnd
            key={f.key}
            bounds="parent"
            disableDragging={readOnly}
            enableResizing={false}
            size={{ width: BOX_W, height: BOX_H }}
            position={{
              x: f.xNorm * pageWidth,
              y: f.yNorm * pageHeight,
            }}
            onDragStop={(_e, d) => {
              const xNorm = Math.min(1, Math.max(0, d.x / pageWidth));
              const yNorm = Math.min(1, Math.max(0, d.y / pageHeight));
              onPositionChange(f.key, xNorm, yNorm);
            }}
            className="border-primary/80 bg-primary/10 flex flex-col items-center justify-center gap-0.5 rounded border-2 border-dashed px-1 text-center text-xs font-medium leading-tight"
          >
            <span>
              {f.type === SignatureFieldType.SIGNATURE
                ? "Signature"
                : f.type === SignatureFieldType.INITIALS
                  ? "Initials"
                  : "Date"}
            </span>
            {readOnly && f.partyLabel ? (
              <span className="text-muted-foreground max-w-full truncate text-[10px] font-normal">
                {f.partyLabel}
              </span>
            ) : null}
          </Rnd>
        ))}
      </div>
    </div>
  );
}

function globalOffsetForPart(
  parts: PdfPart[],
  partIndex: number,
  partPageCounts: Record<string, number>,
): number {
  let off = 0;
  for (let j = 0; j < partIndex; j++) {
    off += partPageCounts[parts[j]!.partId] ?? 0;
  }
  return off;
}

function canRenderPart(
  parts: PdfPart[],
  partIndex: number,
  partPageCounts: Record<string, number>,
): boolean {
  for (let j = 0; j < partIndex; j++) {
    if (partPageCounts[parts[j]!.partId] == null) return false;
  }
  return true;
}

function PartThumbnail({
  part,
  selected,
  onSelect,
}: {
  part: PdfPart;
  selected: boolean;
  onSelect: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "bg-muted/50 w-full overflow-hidden rounded-md border text-left transition-shadow",
        selected
          ? "ring-primary ring-2 ring-offset-2 ring-offset-background"
          : "hover:border-primary/50",
      )}
    >
      {err ? (
        <p className="text-destructive p-2 text-[10px]">{err}</p>
      ) : (
        <Document
          file={part.presignedUrl}
          loading={
            <div className="flex h-28 items-center justify-center">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          }
          onLoadError={(e) => {
            setErr(e instanceof Error ? e.message : "Preview failed");
          }}
        >
          <Page
            pageNumber={1}
            width={112}
            renderAnnotationLayer={false}
            renderTextLayer={false}
          />
        </Document>
      )}
    </button>
  );
}

function PdfPartBlock({
  part,
  globalPageOffset,
  pageWidth,
  onPartLoad,
  pageWrapRefs,
  pageSizes,
  setPageSizes,
  overlayFields,
  isDraft,
  readOnly,
  onPositionChange,
  onPdfPartError,
}: {
  part: PdfPart;
  globalPageOffset: number;
  pageWidth: number;
  onPartLoad: (partId: string, numPages: number) => void;
  pageWrapRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
  pageSizes: Record<number, { w: number; h: number }>;
  setPageSizes: React.Dispatch<
    React.SetStateAction<Record<number, { w: number; h: number }>>
  >;
  overlayFields: EditorField[];
  isDraft: boolean;
  readOnly: boolean;
  onPositionChange: (key: string, xNorm: number, yNorm: number) => void;
  onPdfPartError: (message: string) => void;
}) {
  const [numPages, setNumPages] = useState<number>();

  return (
    <Document
      file={part.presignedUrl}
      loading={
        <div className="flex items-center justify-center gap-2 py-16">
          <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
          <span className="text-muted-foreground text-sm">Loading PDF…</span>
        </div>
      }
      onLoadSuccess={({ numPages: n }) => {
        setNumPages(n);
        onPartLoad(part.partId, n);
      }}
      onLoadError={(err) => {
        const msg = err instanceof Error ? err.message : String(err);
        onPdfPartError(msg);
      }}
    >
      {numPages != null &&
        Array.from({ length: numPages }, (_, pageIndex) => {
          const globalIdx = globalPageOffset + pageIndex;
          return (
            <div
              key={pageIndex}
              ref={(el) => {
                pageWrapRefs.current[globalIdx] = el;
              }}
              className="relative mx-auto mb-6 inline-block w-full max-w-full"
            >
              <Page
                pageNumber={pageIndex + 1}
                width={pageWidth}
                renderAnnotationLayer={false}
                renderTextLayer={false}
                onRenderSuccess={(page) => {
                  setPageSizes((prev) => ({
                    ...prev,
                    [globalIdx]: { w: page.width, h: page.height },
                  }));
                }}
              />
              {pageSizes[globalIdx] && (
                <FieldOverlayLayer
                  pageIndex={globalIdx}
                  pageWidth={pageSizes[globalIdx]!.w}
                  pageHeight={pageSizes[globalIdx]!.h}
                  fields={overlayFields}
                  readOnly={readOnly}
                  onPositionChange={onPositionChange}
                />
              )}
            </div>
          );
        })}
    </Document>
  );
}

export function DocumentWorkspace({ mode }: { mode: "edit" | "preview" }) {
  const isPreview = mode === "preview";
  const { data: user } = useAuth();
  const { documentId } = useParams<{ documentId: string }>();
  const navigate = useNavigate();
  const [currentPage, setCurrentPage] = useState(0);
  const [sending, setSending] = useState(false);
  const [localFields, setLocalFields] = useState<EditorField[]>([]);
  const [partPageCounts, setPartPageCounts] = useState<Record<string, number>>(
    {},
  );
  const [pageSizes, setPageSizes] = useState<
    Record<number, { w: number; h: number }>
  >({});
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pageWidth, setPageWidth] = useState(720);
  const [appending, setAppending] = useState(false);
  const [selectedPartyId, setSelectedPartyId] = useState<string | null>(null);
  const [addingParty, setAddingParty] = useState(false);
  const [partySettingsOpen, setPartySettingsOpen] = useState(false);
  const [partySettingsId, setPartySettingsId] = useState<string | null>(null);
  const [partySettingsLabel, setPartySettingsLabel] = useState("");
  const [savingPartyLabel, setSavingPartyLabel] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageWrapRefs = useRef<(HTMLDivElement | null)[]>([]);
  const appendFileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, error, refetch } = useQuery(
    getDocumentForEditor,
    documentId ? { documentId } : undefined,
    { enabled: !!documentId },
  );

  const parts = data?.parts ?? [];
  const partsKey = parts.map((p) => p.partId).join(",");

  const isDraft = data?.document.status === "DRAFT";

  const signGated = !!user && !user.isAdmin && user.plan === "FREE";

  const totalPages = useMemo(() => {
    return parts.reduce((s, p) => s + (partPageCounts[p.partId] ?? 0), 0);
  }, [parts, partPageCounts]);

  /** Which template part contains the page currently centered in the viewport (left nav highlight). */
  const activePartId = useMemo(() => {
    if (parts.length === 0) return null;
    let acc = 0;
    for (const p of parts) {
      const n = partPageCounts[p.partId] ?? 0;
      if (n === 0) return p.partId;
      if (currentPage < acc + n) return p.partId;
      acc += n;
    }
    return parts[parts.length - 1]!.partId;
  }, [parts, partPageCounts, currentPage]);

  const parties = data?.parties ?? [];

  const fieldsForOverlay = useMemo(() => {
    if (isPreview || !isDraft) return localFields;
    if (!selectedPartyId) return [];
    return localFields.filter((f) => f.documentPartyId === selectedPartyId);
  }, [isPreview, isDraft, localFields, selectedPartyId]);

  const overlayReadOnly = isPreview || !isDraft;

  useLayoutEffect(() => {
    if (isLoading || error || !data) return;
    const el = scrollRef.current;
    if (!el) return;

    const update = () => {
      const styles =
        typeof getComputedStyle !== "undefined" ? getComputedStyle(el) : null;
      const pl = styles ? parseFloat(styles.paddingLeft) || 0 : 0;
      const pr = styles ? parseFloat(styles.paddingRight) || 0 : 0;
      const inner = el.clientWidth - pl - pr;
      setPageWidth(Math.min(900, Math.max(280, inner)));
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isLoading, error, data?.document.id, partsKey]);

  useEffect(() => {
    if (!data?.fields || !data?.parties?.length) return;
    const labelByPartyId = Object.fromEntries(
      data.parties.map((p) => [p.id, p.label]),
    );
    const partyIds = new Set(data.parties.map((p) => p.id));
    setLocalFields((prev) => {
      const fromServer = data.fields.map((f) => ({
        key: f.id,
        type: f.type as SignatureFieldTypeValue,
        xNorm: f.xPos,
        yNorm: f.yPos,
        page: f.pageNumber,
        documentPartyId: f.documentPartyId,
        partyLabel: labelByPartyId[f.documentPartyId],
      }));
      const serverIds = new Set(data.fields.map((f) => f.id));
      const unsavedLocal = prev.filter(
        (f) =>
          !serverIds.has(f.key) && partyIds.has(f.documentPartyId),
      );
      const unsavedWithLabels = unsavedLocal.map((f) => ({
        ...f,
        partyLabel:
          labelByPartyId[f.documentPartyId] ?? f.partyLabel,
      }));
      return [...fromServer, ...unsavedWithLabels];
    });
  }, [data?.document.id, data?.fields, data?.parties]);

  useEffect(() => {
    if (!data?.parties?.length) return;
    setSelectedPartyId((prev) => {
      if (prev && data.parties.some((p) => p.id === prev)) return prev;
      return data.parties[0]!.id;
    });
  }, [data?.document.id, data?.parties]);

  useEffect(() => {
    if (!data?.document.id) return;
    setPartPageCounts({});
    setPageSizes({});
    setPdfError(null);
    pageWrapRefs.current = [];
  }, [data?.document.id, partsKey]);

  useEffect(() => {
    if (parts.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const p of parts) {
        if (cancelled) return;
        try {
          const loadingTask = pdfjs.getDocument({
            url: p.presignedUrl,
            withCredentials: false,
          });
          const pdf = await loadingTask.promise;
          if (cancelled) {
            await pdf.destroy();
            return;
          }
          const n = pdf.numPages;
          await pdf.destroy();
          setPartPageCounts((prev) =>
            prev[p.partId] != null ? prev : { ...prev, [p.partId]: n },
          );
        } catch {
          // PdfPartBlock will set numPages on render
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [partsKey]);

  const handlePositionChange = useCallback(
    (key: string, xNorm: number, yNorm: number) => {
      setLocalFields((prev) =>
        prev.map((f) => (f.key === key ? { ...f, xNorm, yNorm } : f)),
      );
    },
    [],
  );

  const onPartLoad = useCallback((partId: string, n: number) => {
    setPartPageCounts((prev) => ({ ...prev, [partId]: n }));
  }, []);

  /** Scroll the single middle column to the first page of a template part (nav shortcut). */
  const scrollToPart = useCallback(
    (partId: string) => {
      const idx = parts.findIndex((p) => p.partId === partId);
      if (idx < 0) return;
      const off = globalOffsetForPart(parts, idx, partPageCounts);
      const el = pageWrapRefs.current[off];
      if (el && scrollRef.current) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      setCurrentPage(off);
    },
    [parts, partPageCounts],
  );

  const updateCurrentPageFromScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root || totalPages === 0) return;
    const rootRect = root.getBoundingClientRect();
    const centerY = rootRect.top + rootRect.height / 2;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < totalPages; i++) {
      const el = pageWrapRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const dist = Math.abs(mid - centerY);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    setCurrentPage(best);
  }, [totalPages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateCurrentPageFromScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    updateCurrentPageFromScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [updateCurrentPageFromScroll, totalPages]);

  useEffect(() => {
    setPageSizes({});
  }, [pageWidth, data?.document.id, partsKey]);

  const addField = (type: SignatureFieldTypeValue) => {
    if (!isDraft || isPreview) return;
    const partyId = selectedPartyId ?? parties[0]?.id;
    if (!partyId) return;
    const partyLabel = parties.find((p) => p.id === partyId)?.label;
    const key = crypto.randomUUID();
    setLocalFields((prev) => [
      ...prev,
      {
        key,
        type,
        xNorm: 0.2,
        yNorm: 0.2,
        page: currentPage + 1,
        documentPartyId: partyId,
        partyLabel,
      },
    ]);
  };

  const handleAddParty = async () => {
    if (!documentId) return;
    setAddingParty(true);
    try {
      const row = await addDocumentParty({ documentId });
      toast({ title: "Party added", description: row.label });
      await refetch();
      setSelectedPartyId(row.id);
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Could not add party";
      toast({
        title: "Add party failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setAddingParty(false);
    }
  };

  const handleSendDocument = async () => {
    if (!documentId) return;
    setSending(true);
    try {
      await sendDocument({ documentId });
      toast({ title: "Document sent", description: "Fields are now locked." });
      await refetch();
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Send failed";
      toast({
        title: "Could not send",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const handleSaveFields = async (): Promise<boolean> => {
    if (!documentId) return false;
    try {
      await saveFields({
        documentId,
        fields: localFields.map((f) => ({
          type: f.type,
          x: f.xNorm,
          y: f.yNorm,
          page: f.page,
          documentPartyId: f.documentPartyId,
        })),
      });
      toast({ title: "Placements saved" });
      await refetch();
      return true;
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Save failed";
      toast({
        title: "Save failed",
        description: message,
        variant: "destructive",
      });
      return false;
    }
  };

  const handleSaveAndPreview = async () => {
    if (!documentId) return;
    const ok = await handleSaveFields();
    if (ok) {
      navigate(
        routes.DocumentPreviewRoute.build({ params: { documentId } }),
      );
    }
  };

  const scrollToFieldKey = useCallback((fieldKey: string) => {
    const f = localFields.find((x) => x.key === fieldKey);
    if (!f) return;
    const idx = f.page - 1;
    const el = pageWrapRefs.current[idx];
    if (el && scrollRef.current) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setCurrentPage(Math.max(0, idx));
  }, [localFields]);

  const fieldsForParty = useCallback(
    (partyId: string) =>
      [...localFields]
        .filter((f) => f.documentPartyId === partyId)
        .sort((a, b) => a.page - b.page || a.key.localeCompare(b.key)),
    [localFields],
  );

  const handleAppendFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !documentId) return;

    setAppending(true);
    try {
      const fileBase64 = await fileToBase64(file);
      await appendPdfToTemplate({
        templateDocumentId: documentId,
        fileName: file.name,
        fileBase64,
        contentType: "application/pdf",
      });
      toast({
        title: "Document appended",
        description: `${file.name} was added to this template.`,
      });
      await refetch();
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Append failed";
      toast({
        title: "Could not append",
        description: message,
        variant: "destructive",
      });
    } finally {
      setAppending(false);
    }
  };

  const openPartySettings = (partyId: string, label: string) => {
    setPartySettingsId(partyId);
    setPartySettingsLabel(label);
    setPartySettingsOpen(true);
  };

  const handleSavePartySettings = async () => {
    if (!documentId || !partySettingsId) return;
    const label = partySettingsLabel.trim();
    if (!label) {
      toast({ title: "Label required", variant: "destructive" });
      return;
    }
    setSavingPartyLabel(true);
    try {
      await updateDocumentParty({
        documentId,
        partyId: partySettingsId,
        label,
      });
      toast({ title: "Party updated" });
      setPartySettingsOpen(false);
      setPartySettingsId(null);
      await refetch();
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Update failed";
      toast({
        title: "Could not update party",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSavingPartyLabel(false);
    }
  };

  const handleRemoveParty = async (partyId: string) => {
    if (!documentId) return;
    const party = parties.find((p) => p.id === partyId);
    if (
      !window.confirm(
        party
          ? `Remove “${party.label}” and all of its fields from this template?`
          : "Remove this party?",
      )
    ) {
      return;
    }
    try {
      await removeDocumentParty({ documentId, partyId });
      toast({ title: "Party removed" });
      await refetch();
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Remove failed";
      toast({
        title: "Could not remove party",
        description: message,
        variant: "destructive",
      });
    }
  };

  if (!documentId) {
    return (
      <p className="text-muted-foreground p-6 text-sm">Missing document id.</p>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-10">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>Loading document…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <p className="text-destructive text-sm">
          {error ? String(error) : "Could not load document."}
        </p>
        <Button asChild variant="link" className="mt-2 px-0">
          <Link to={routes.DocumentsRoute.to}>Back to dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-background mx-auto box-border flex h-[calc(100dvh-3.5rem)] min-h-0 w-full max-w-[1920px] flex-col overflow-hidden px-4 sm:px-6 lg:px-10">
      <header className="border-border bg-card/80 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b py-3 backdrop-blur">
        <nav
          className="text-muted-foreground flex min-w-0 max-w-[55%] items-center gap-1.5 text-sm"
          aria-label="Breadcrumb"
        >
          <Link
            to={routes.DocumentsRoute.to}
            className="hover:text-foreground truncate font-medium"
          >
            Documents
          </Link>
          <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />
          {isPreview ? (
            <>
              <Link
                to={routes.DocumentEditorRoute.to}
                params={{ documentId }}
                className="hover:text-foreground max-w-[40%] truncate font-medium"
              >
                {data.document.name}
              </Link>
              <ChevronRight className="h-4 w-4 shrink-0 opacity-60" />
              <span className="text-foreground truncate font-semibold">
                Preview
              </span>
            </>
          ) : (
            <span className="text-foreground truncate font-semibold">
              {data.document.name}
            </span>
          )}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs capitalize">
            {data.document.status.toLowerCase()}
          </span>
          <span className="text-muted-foreground text-xs">
            · Page {totalPages > 0 ? currentPage + 1 : "—"}
            {totalPages > 0 ? ` / ${totalPages}` : ""}
          </span>
          {isPreview ? (
            <Button type="button" size="sm" variant="secondary" asChild>
              <Link to={routes.DocumentEditorRoute.to} params={{ documentId }}>
                Edit
              </Link>
            </Button>
          ) : null}
          {!isPreview && isDraft && (
            <>
              <Button type="button" size="sm" variant="outline" asChild>
                <Link
                  to={routes.DocumentPreviewRoute.to}
                  params={{ documentId }}
                >
                  <Eye className="mr-1 h-4 w-4" />
                  Preview
                </Link>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void handleSaveFields()}
              >
                <Save className="mr-1 h-4 w-4" />
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void handleSaveAndPreview()}
              >
                <Eye className="mr-1 h-4 w-4" />
                Save &amp; preview
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                disabled={sending}
                onClick={() => void handleSendDocument()}
              >
                {sending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-1 h-4 w-4" />
                )}
                Send
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 items-stretch overflow-hidden">
        {/* Left: template parts + append — own scroll (needs bounded parent height) */}
        <aside className="border-border flex min-h-0 w-56 shrink-0 flex-col overflow-hidden border-r">
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-3 [scrollbar-gutter:stable]">
          <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
            Template parts
          </p>
          <div className="space-y-3">
            {parts.map((part) => (
              <div key={part.partId}>
                <p className="mb-1 truncate text-xs font-medium">{part.label}</p>
                <PartThumbnail
                  part={part}
                  selected={part.partId === activePartId}
                  onSelect={() => scrollToPart(part.partId)}
                />
              </div>
            ))}
          </div>
          {!isPreview && isDraft && (
            <>
              <input
                ref={appendFileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => void handleAppendFileChange(e)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4 w-full"
                disabled={appending}
                onClick={() => appendFileInputRef.current?.click()}
              >
                {appending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <FilePlus className="mr-1 h-4 w-4" />
                )}
                Append document
              </Button>
            </>
          )}
          {!isPreview && (
          <PremiumFeature gated={signGated}>
            <Card className="mt-4">
              <CardHeader className="p-3 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <PenLine className="h-4 w-4" />
                  Saved signature
                </CardTitle>
                <CardDescription className="text-xs">
                  PNG for signing fields
                </CardDescription>
              </CardHeader>
              <CardContent className="p-3 pt-0">
                <SignaturePad
                  onSaved={async () => {
                    toast({ title: "Signature saved to your account" });
                  }}
                />
              </CardContent>
            </Card>
          </PremiumFeature>
          )}
          </div>
        </aside>

        {/* Middle: one continuous stack — template + all appends; single vertical scroll */}
        <main
          ref={scrollRef}
          className="bg-muted/20 flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-4 [scrollbar-gutter:stable]"
        >
          {pdfError && (
            <p className="text-destructive mb-2 w-full max-w-full text-sm">
              Could not display PDF: {pdfError}
            </p>
          )}
          {parts.map((part, partIdx) => {
            if (!canRenderPart(parts, partIdx, partPageCounts)) {
              return (
                <div
                  key={part.partId}
                  className="text-muted-foreground flex w-full max-w-full items-center justify-center gap-2 py-12 text-sm"
                >
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Loading previous part…
                </div>
              );
            }
            const globalOffset = globalOffsetForPart(
              parts,
              partIdx,
              partPageCounts,
            );
            return (
              <PdfPartBlock
                key={part.partId}
                part={part}
                globalPageOffset={globalOffset}
                pageWidth={pageWidth}
                onPartLoad={onPartLoad}
                pageWrapRefs={pageWrapRefs}
                pageSizes={pageSizes}
                setPageSizes={setPageSizes}
                overlayFields={fieldsForOverlay}
                isDraft={!!isDraft && !isPreview}
                readOnly={overlayReadOnly}
                onPositionChange={handlePositionChange}
                onPdfPartError={(msg) => setPdfError(msg)}
              />
            );
          })}
        </main>

        {/* Right: parties (scroll) + field types (fixed below) */}
        <aside className="border-border flex h-full min-h-0 w-80 shrink-0 flex-col overflow-hidden border-l bg-muted/30">
          {/* Parties — scrolls when there are many */}
          <div className="flex min-h-0 flex-1 flex-col px-3 pt-3">
            <p className="text-muted-foreground mb-2 shrink-0 text-xs font-semibold uppercase tracking-wider">
              Parties
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 [-ms-overflow-style:auto] [scrollbar-gutter:stable]">
              <div className="flex flex-col gap-2.5 pb-1">
                {parties.map((p) => {
                  const pFields = fieldsForParty(p.id);
                  return (
                    <div
                      key={p.id}
                      className={cn(
                        "space-y-2 rounded-lg border border-border/80 bg-card/80 p-2.5 shadow-sm",
                        isDraft &&
                          !isPreview &&
                          selectedPartyId === p.id &&
                          "ring-primary ring-2 ring-offset-2 ring-offset-background",
                      )}
                    >
                      <div className="flex items-center gap-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-9 min-w-0 flex-1 justify-start px-2 font-medium"
                          disabled={!isDraft || isPreview}
                          onClick={() =>
                            isDraft && !isPreview && setSelectedPartyId(p.id)
                          }
                        >
                          <span className="truncate text-left text-sm">
                            {p.label}
                          </span>
                        </Button>
                        {isDraft && !isPreview && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0"
                              aria-label="Party settings"
                              onClick={() =>
                                openPartySettings(p.id, p.label)
                              }
                            >
                              <Settings2 className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive h-8 w-8 shrink-0"
                              disabled={parties.length <= 1}
                              aria-label="Delete party"
                              onClick={() => void handleRemoveParty(p.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                      {((isDraft && !isPreview) || isPreview) &&
                        pFields.length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 w-full justify-between px-2 text-xs font-normal"
                              disabled={pFields.length === 0}
                            >
                              {pFields.length === 0
                                ? "No fields yet"
                                : "Fields on document"}
                              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            className="max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
                          >
                            {pFields.map((f) => (
                              <DropdownMenuItem
                                key={f.key}
                                onClick={() => scrollToFieldKey(f.key)}
                              >
                                {fieldRowLabel(f)}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      {!isDraft && !isPreview && pFields.length > 0 && (
                        <p className="text-muted-foreground px-0.5 text-xs">
                          {pFields.length} field
                          {pFields.length === 1 ? "" : "s"} for this party
                        </p>
                      )}
                    </div>
                  );
                })}
                {isDraft && !isPreview && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="justify-start text-muted-foreground"
                    disabled={addingParty}
                    onClick={() => void handleAddParty()}
                  >
                    {addingParty ? (
                      <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4 shrink-0" />
                    )}
                    Add party
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Field types — fixed below parties; preview shows help text only */}
          <div className="border-border bg-background/95 shrink-0 border-t px-3 py-3 shadow-[0_-4px_12px_-4px_rgba(0,0,0,0.08)] backdrop-blur-sm">
            {isPreview ? (
              <>
                <p className="text-muted-foreground mb-1 text-xs font-semibold uppercase tracking-wider">
                  Preview
                </p>
                <p className="text-muted-foreground text-sm leading-snug">
                  Read-only view with every party&apos;s fields on the PDF.{" "}
                  <Link
                    to={routes.DocumentEditorRoute.to}
                    params={{ documentId }}
                    className="text-primary font-medium underline underline-offset-2"
                  >
                    Back to edit
                  </Link>
                  .
                </p>
              </>
            ) : (
              <>
                <p className="text-muted-foreground mb-1 text-xs font-semibold uppercase tracking-wider">
                  Field types
                </p>
                <p className="text-muted-foreground mb-3 text-xs leading-snug">
                  {isDraft && selectedPartyId ? (
                    <>
                      Add to{" "}
                      <span className="text-foreground font-medium">
                        {parties.find((p) => p.id === selectedPartyId)?.label ??
                          "party"}
                      </span>
                      . Page {totalPages > 0 ? currentPage + 1 : "—"}
                      {totalPages > 0 ? ` / ${totalPages}` : ""}.
                    </>
                  ) : (
                    <>
                      Page {totalPages > 0 ? currentPage + 1 : "—"}
                      {totalPages > 0 ? ` / ${totalPages}` : ""}.
                    </>
                  )}
                </p>
                {isDraft && (
                  <PremiumFeature gated={signGated}>
                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        className="justify-start"
                        disabled={!selectedPartyId}
                        onClick={() => addField(SignatureFieldType.SIGNATURE)}
                      >
                        <PenLine className="mr-2 h-4 w-4" />
                        Signature
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="justify-start"
                        disabled={!selectedPartyId}
                        onClick={() => addField(SignatureFieldType.INITIALS)}
                      >
                        <Type className="mr-2 h-4 w-4" />
                        Initials
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="justify-start"
                        disabled={!selectedPartyId}
                        onClick={() => addField(SignatureFieldType.DATE)}
                      >
                        <Calendar className="mr-2 h-4 w-4" />
                        Date
                      </Button>
                    </div>
                  </PremiumFeature>
                )}
                {!isDraft && (
                  <p className="text-muted-foreground text-sm">
                    This document is no longer editable. All parties&apos; fields
                    are shown on the PDF.
                  </p>
                )}
              </>
            )}
          </div>
        </aside>
      </div>

      <Dialog
        open={partySettingsOpen}
        onOpenChange={(open) => {
          setPartySettingsOpen(open);
          if (!open) setPartySettingsId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Party settings</DialogTitle>
            <DialogDescription>
              Change how this party is labeled on the template and in field tags.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="party-label-edit">Display name</Label>
            <Input
              id="party-label-edit"
              value={partySettingsLabel}
              onChange={(e) => setPartySettingsLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSavePartySettings();
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPartySettingsOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={savingPartyLabel || !partySettingsLabel.trim()}
              onClick={() => void handleSavePartySettings()}
            >
              {savingPartyLabel ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function DocumentEditorPage() {
  return <DocumentWorkspace mode="edit" />;
}
