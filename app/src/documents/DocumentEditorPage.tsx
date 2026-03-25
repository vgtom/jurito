import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useAuth } from "wasp/client/auth";
import {
  getDocumentForEditor,
  saveFields,
  saveSignatureImage,
  sendDocument,
  useQuery,
} from "wasp/client/operations";
import { Link, routes } from "wasp/client/router";
import { ArrowLeft, Loader2, PenLine, Plus, Save, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { useParams } from "react-router-dom";

import { PremiumFeature } from "../client/components/billing/PremiumFeature";
import { Button } from "../client/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../client/components/ui/card";
import { toast } from "../client/hooks/use-toast";
import { SignaturePad } from "./SignaturePad";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Matches Prisma `SignatureFieldType` — avoid importing `@prisma/client` in client bundles. */
const SignatureFieldType = {
  SIGNATURE: "SIGNATURE",
  INITIALS: "INITIALS",
  DATE: "DATE",
} as const;

type SignatureFieldTypeValue =
  (typeof SignatureFieldType)[keyof typeof SignatureFieldType];

const BOX_W = 140;
const BOX_H = 48;

export type EditorField = {
  key: string;
  type: SignatureFieldTypeValue;
  /** Normalized 0–1, top-left of placement box */
  xNorm: number;
  yNorm: number;
  /** 1-based page index */
  page: number;
};

function FieldOverlayLayer({
  pageIndex,
  pageWidth,
  pageHeight,
  fields,
  readOnly,
  onPositionChange,
}: {
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
            className="border-primary/80 bg-primary/10 flex items-center justify-center rounded border-2 border-dashed text-xs font-medium"
          >
            {f.type === SignatureFieldType.SIGNATURE
              ? "Signature"
              : f.type === SignatureFieldType.INITIALS
                ? "Initials"
                : "Date"}
          </Rnd>
        ))}
      </div>
    </div>
  );
}

export default function DocumentEditorPage() {
  const { data: user } = useAuth();
  const { documentId } = useParams<{ documentId: string }>();
  const [currentPage, setCurrentPage] = useState(0);
  const [sending, setSending] = useState(false);
  const [localFields, setLocalFields] = useState<EditorField[]>([]);
  const [numPages, setNumPages] = useState<number>();
  const [pageSizes, setPageSizes] = useState<
    Record<number, { w: number; h: number }>
  >({});
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pageWidth, setPageWidth] = useState(800);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageWrapRefs = useRef<(HTMLDivElement | null)[]>([]);

  const { data, isLoading, error, refetch } = useQuery(
    getDocumentForEditor,
    documentId ? { documentId } : undefined,
    { enabled: !!documentId },
  );

  const isDraft = data?.document.status === "DRAFT";

  const signGated =
    !!user && !user.isAdmin && user.plan === "FREE";

  useEffect(() => {
    const update = () => {
      setPageWidth(Math.min(800, Math.max(320, window.innerWidth - 48)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!data?.fields) return;
    setLocalFields(
      data.fields.map((f) => ({
        key: f.id,
        type: f.type as SignatureFieldTypeValue,
        xNorm: f.xPos,
        yNorm: f.yPos,
        page: f.pageNumber,
      })),
    );
  }, [data?.document.id, data?.fields]);

  useEffect(() => {
    if (!data?.document.id) return;
    setNumPages(undefined);
    setPageSizes({});
    setPdfError(null);
  }, [data?.document.id]);

  const handlePositionChange = useCallback(
    (key: string, xNorm: number, yNorm: number) => {
      setLocalFields((prev) =>
        prev.map((f) => (f.key === key ? { ...f, xNorm, yNorm } : f)),
      );
    },
    [],
  );

  const updateCurrentPageFromScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root || !numPages) return;
    const rootRect = root.getBoundingClientRect();
    const centerY = rootRect.top + rootRect.height / 2;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < numPages; i++) {
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
  }, [numPages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateCurrentPageFromScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    updateCurrentPageFromScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [updateCurrentPageFromScroll, numPages]);

  useEffect(() => {
    setPageSizes({});
  }, [pageWidth, data?.document.id]);

  const addSignatureField = () => {
    if (!isDraft) return;
    const key = crypto.randomUUID();
    setLocalFields((prev) => [
      ...prev,
      {
        key,
        type: SignatureFieldType.SIGNATURE,
        xNorm: 0.2,
        yNorm: 0.2,
        page: currentPage + 1,
      },
    ]);
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

  const handleSaveFields = async () => {
    if (!documentId) return;
    try {
      await saveFields({
        documentId,
        fields: localFields.map((f) => ({
          type: f.type,
          x: f.xNorm,
          y: f.yNorm,
          page: f.page,
        })),
      });
      toast({ title: "Placements saved" });
      await refetch();
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Save failed";
      toast({ title: "Save failed", description: message, variant: "destructive" });
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
          <Link to={routes.DemoAppRoute.to}>Back to dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen pb-16">
      <div className="border-border bg-card/80 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link to={routes.DemoAppRoute.to}>
                <ArrowLeft className="mr-1 h-4 w-4" />
                Dashboard
              </Link>
            </Button>
            <div>
              <h1 className="text-lg font-semibold leading-tight">
                {data.document.name}
              </h1>
              <p className="text-muted-foreground text-xs capitalize">
                {data.document.status.toLowerCase()} · Page {currentPage + 1}
                {numPages != null ? ` / ${numPages}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isDraft && (
              <>
                <PremiumFeature gated={signGated}>
                  <Button type="button" size="sm" onClick={addSignatureField}>
                    <Plus className="mr-1 h-4 w-4" />
                    Add signature
                  </Button>
                </PremiumFeature>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={handleSaveFields}
                >
                  <Save className="mr-1 h-4 w-4" />
                  Save placements
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
        </div>
      </div>

      <div className="mx-auto max-w-6xl space-y-8 px-4 pt-6">
        <PremiumFeature gated={signGated}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <PenLine className="h-4 w-4" />
                Saved signature (PNG)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SignaturePad
                onSaved={async () => {
                  toast({ title: "Signature saved to your account" });
                }}
              />
            </CardContent>
          </Card>
        </PremiumFeature>

        <div
          ref={scrollRef}
          className="bg-muted/30 max-h-[70vh] overflow-y-auto overflow-x-hidden rounded-lg border"
        >
          {pdfError && (
            <p className="text-destructive p-4 text-sm">
              Could not display PDF: {pdfError}
            </p>
          )}
          <Document
            file={data.pdfUrl}
            loading={
              <div className="flex items-center justify-center gap-2 py-20">
                <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                <span className="text-muted-foreground text-sm">
                  Loading PDF…
                </span>
              </div>
            }
            onLoadSuccess={({ numPages: n }) => {
              setNumPages(n);
              setPdfError(null);
            }}
            onLoadError={(err) => {
              const msg =
                err instanceof Error ? err.message : String(err);
              setPdfError(msg);
            }}
          >
            {numPages != null &&
              Array.from({ length: numPages }, (_, pageIndex) => (
                <div
                  key={pageIndex}
                  ref={(el) => {
                    pageWrapRefs.current[pageIndex] = el;
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
                        [pageIndex]: { w: page.width, h: page.height },
                      }));
                    }}
                  />
                  {pageSizes[pageIndex] && (
                    <FieldOverlayLayer
                      pageIndex={pageIndex}
                      pageWidth={pageSizes[pageIndex]!.w}
                      pageHeight={pageSizes[pageIndex]!.h}
                      fields={localFields}
                      readOnly={!isDraft}
                      onPositionChange={handlePositionChange}
                    />
                  )}
                </div>
              ))}
          </Document>
        </div>
      </div>
    </div>
  );
}
