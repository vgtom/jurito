import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { config } from "wasp/client";

import { Button } from "../client/components/ui/button";
import { Input } from "../client/components/ui/input";
import { Label } from "../client/components/ui/label";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../client/components/ui/card";
import { toast } from "../client/hooks/use-toast";
import { cn } from "../client/utils";
import { SignatureCaptureModal } from "./signing/SignatureCaptureModal";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfPart = {
  partId: string;
  label: string;
  presignedUrl: string;
};

type SigningFieldPayload = {
  id: string;
  type: string;
  xPos: number;
  yPos: number;
  pageNumber: number;
  /** From template save order; older payloads may omit (treated as 0). */
  placementOrder?: number;
  documentPartyId: string;
  partyLabel: string;
};

type SigningSavedFieldValue = {
  fieldId: string;
  documentPartyId: string;
  textValue: string | null;
  imagePresignedUrl: string | null;
};

type SigningInvitePayload = {
  documentName: string;
  partyLabel: string;
  signerName: string;
  signerEmail: string | null;
  documentPartyId: string;
  documentId: string;
  inviterEmail: string | null;
  parts: PdfPart[];
  fields: SigningFieldPayload[];
  savedFieldValues: SigningSavedFieldValue[];
};

const BOX_W = 140;
const BOX_H = 48;

function fieldTypeTitle(t: string): string {
  switch (t) {
    case "SIGNATURE":
      return "Signature";
    case "INITIALS":
      return "Initials";
    case "DATE":
      return "Date";
    case "TEXT":
      return "Text";
    case "IMAGE":
      return "Image";
    default:
      return t;
  }
}

function fieldUsesImageModal(type: string): boolean {
  return type === "SIGNATURE" || type === "IMAGE";
}

function fieldUsesTextOnly(type: string): boolean {
  return type === "TEXT" || type === "DATE" || type === "INITIALS";
}

/** Two-letter style initials from signer display name (for INITIALS fields). */
function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) {
    const w = parts[0]!;
    return w.slice(0, 2).toUpperCase();
  }
  return (
    (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
  );
}

function isSigningFieldFilled(
  f: SigningFieldPayload,
  values: Record<string, { text?: string; imageDataUrl?: string }>,
  serverByFieldId: Record<string, { text?: string; imageUrl?: string }>,
): boolean {
  const v = values[f.id];
  const s = serverByFieldId[f.id];
  if (f.type === "SIGNATURE" || f.type === "IMAGE") {
    return !!(v?.imageDataUrl || s?.imageUrl);
  }
  const t = v?.text ?? s?.text;
  return !!(t && t.trim());
}

/** Downscale PNG data URLs so POST bodies stay small (avoids 413 / timeouts). */
function compressPngDataUrl(dataUrl: string, maxWidth = 520): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function hintLabelForFieldType(type: string): string {
  switch (type) {
    case "SIGNATURE":
      return "Click to sign";
    case "IMAGE":
      return "Click to add image";
    case "INITIALS":
      return "Click to insert initials";
    case "DATE":
      return "Click to select date";
    case "TEXT":
      return "Click to enter text";
    default:
      return "Click to insert field";
  }
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

function SignFieldOverlay({
  pageIndex,
  pageWidth,
  pageHeight,
  myFieldsInOrder,
  currentIndex,
  values,
  serverByFieldId,
  livePreview,
  fieldGuideDismissed,
  onFieldClick,
}: {
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  /** This signer’s fields only, in signing order */
  myFieldsInOrder: SigningFieldPayload[];
  currentIndex: number;
  values: Record<string, { text?: string; imageDataUrl?: string }>;
  serverByFieldId: Record<string, { text?: string; imageUrl?: string }>;
  livePreview: { fieldId: string; dataUrl: string } | null;
  fieldGuideDismissed: Record<string, boolean>;
  onFieldClick: (f: SigningFieldPayload) => void;
}) {
  const pageNum = pageIndex + 1;
  const pageFields = myFieldsInOrder.filter((f) => f.pageNumber === pageNum);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[2]"
      style={{ width: pageWidth, height: pageHeight }}
    >
      <div className="relative h-full w-full">
        {pageFields.map((f) => {
          const stepIndex = myFieldsInOrder.findIndex((x) => x.id === f.id);
          const isCurrent = stepIndex === currentIndex;
          const isFuture = stepIndex > currentIndex;
          const v = values[f.id];
          const s = serverByFieldId[f.id];
          const previewUrl =
            livePreview?.fieldId === f.id ? livePreview.dataUrl : undefined;
          const imageSrc = v?.imageDataUrl ?? s?.imageUrl ?? previewUrl;
          const text = v?.text ?? s?.text;
          const hasImg = !!imageSrc;
          const hasText = !!(text && text.trim());
          const showHint =
            isCurrent &&
            !previewUrl &&
            !fieldGuideDismissed[f.id];

          return (
            <div
              key={f.id}
              className="pointer-events-auto absolute"
              style={{
                left: f.xPos * pageWidth,
                top: f.yPos * pageHeight,
                width: BOX_W,
                minHeight: BOX_H,
              }}
            >
              {showHint ? (
                <div
                  className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-0.5 flex -translate-x-1/2 flex-col items-center"
                  aria-hidden
                >
                  <div className="rounded-md bg-amber-200 px-3 py-1.5 text-center text-xs font-medium text-amber-950 shadow-sm">
                    {hintLabelForFieldType(f.type)}
                  </div>
                  <div className="h-0 w-0 border-x-[7px] border-x-transparent border-t-[8px] border-t-amber-200" />
                </div>
              ) : null}
              <button
                type="button"
                disabled={stepIndex !== currentIndex}
                onClick={() => {
                  if (stepIndex === currentIndex) onFieldClick(f);
                }}
                className={cn(
                  "flex h-full min-h-[48px] w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded border-2 border-dashed px-1 text-center text-xs font-medium leading-tight transition-colors",
                  isCurrent
                    ? "border-primary bg-primary/10 hover:bg-primary/15"
                    : isFuture
                      ? "cursor-not-allowed border-muted-foreground/30 bg-muted/25 opacity-55"
                      : "cursor-default border-muted-foreground/45 bg-muted/35 opacity-90",
                  isCurrent && "cursor-pointer",
                )}
              >
                {hasImg ? (
                  <img
                    src={imageSrc}
                    alt=""
                    className="max-h-10 w-full object-contain"
                  />
                ) : hasText ? (
                  <span className="line-clamp-2 w-full break-words text-[10px]">
                    {text}
                  </span>
                ) : (
                  <span>{fieldTypeTitle(f.type)}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SignPdfPartBlock({
  part,
  globalPageOffset,
  pageWidth,
  onPartLoad,
  pageWrapRefs,
  pageSizes,
  setPageSizes,
  myFieldsInOrder,
  currentIndex,
  values,
  serverByFieldId,
  livePreview,
  fieldGuideDismissed,
  onFieldClick,
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
  myFieldsInOrder: SigningFieldPayload[];
  currentIndex: number;
  values: Record<string, { text?: string; imageDataUrl?: string }>;
  serverByFieldId: Record<string, { text?: string; imageUrl?: string }>;
  livePreview: { fieldId: string; dataUrl: string } | null;
  fieldGuideDismissed: Record<string, boolean>;
  onFieldClick: (f: SigningFieldPayload) => void;
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
                <SignFieldOverlay
                  pageIndex={globalIdx}
                  pageWidth={pageSizes[globalIdx]!.w}
                  pageHeight={pageSizes[globalIdx]!.h}
                  myFieldsInOrder={myFieldsInOrder}
                  currentIndex={currentIndex}
                  values={values}
                  serverByFieldId={serverByFieldId}
                  livePreview={livePreview}
                  fieldGuideDismissed={fieldGuideDismissed}
                  onFieldClick={onFieldClick}
                />
              )}
            </div>
          );
        })}
    </Document>
  );
}

export default function SignDocumentPage() {
  const { token } = useParams<{ token: string }>();
  const [invite, setInvite] = useState<SigningInvitePayload | null | undefined>(
    undefined,
  );
  const [loadError, setLoadError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [partPageCounts, setPartPageCounts] = useState<Record<string, number>>(
    {},
  );
  const [pageSizes, setPageSizes] = useState<
    Record<number, { w: number; h: number }>
  >({});
  const [pageWidth, setPageWidth] = useState(640);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageWrapRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [values, setValues] = useState<
    Record<string, { text?: string; imageDataUrl?: string }>
  >({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [sigModalOpen, setSigModalOpen] = useState(false);
  const [sigModalField, setSigModalField] =
    useState<SigningFieldPayload | null>(null);
  /** Live signature/image while the modal is open (stroke or typed preview). */
  const [signatureLivePreview, setSignatureLivePreview] = useState<{
    fieldId: string;
    dataUrl: string;
  } | null>(null);
  /** Hides the amber "Click to …" guide after the user interacts with that field once. */
  const [fieldGuideDismissed, setFieldGuideDismissed] = useState<
    Record<string, boolean>
  >({});
  const [declined, setDeclined] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const loadInvite = useCallback(async () => {
    if (!token || token.length < 16) {
      setInvite(null);
      setLoadError(true);
      return;
    }
    setLoadError(false);
    setInvite(undefined);
    try {
      const res = await fetch(
        `${config.apiUrl}/signing-invite/${encodeURIComponent(token)}`,
      );
      if (res.status === 404) {
        setInvite(null);
        return;
      }
      if (!res.ok) {
        setLoadError(true);
        setInvite(null);
        return;
      }
      const data = (await res.json()) as SigningInvitePayload | null;
      setInvite(
        data
          ? {
              ...data,
              savedFieldValues: data.savedFieldValues ?? [],
            }
          : null,
      );
    } catch {
      setLoadError(true);
      setInvite(null);
    }
  }, [token]);

  useEffect(() => {
    void loadInvite();
  }, [loadInvite]);

  const parts = invite?.parts ?? [];
  const partsKey = parts.map((p) => p.partId).join(",");

  const myFields = useMemo(() => {
    if (!invite) return [];
    return [...invite.fields]
      .filter((f) => f.documentPartyId === invite.documentPartyId)
      .sort(
        (a, b) =>
          (a.placementOrder ?? 0) - (b.placementOrder ?? 0) ||
          a.pageNumber - b.pageNumber ||
          a.id.localeCompare(b.id),
      );
  }, [invite]);

  /** Server-stored values for this signer’s fields (and same keys used in sidebar). */
  const serverByFieldId = useMemo(() => {
    const m: Record<string, { text?: string; imageUrl?: string }> = {};
    for (const r of invite?.savedFieldValues ?? []) {
      if (r.documentPartyId !== invite?.documentPartyId) continue;
      if (r.textValue) m[r.fieldId] = { text: r.textValue };
      else if (r.imagePresignedUrl) m[r.fieldId] = { imageUrl: r.imagePresignedUrl };
    }
    return m;
  }, [invite]);

  useEffect(() => {
    if (!invite) return;
    const initial: Record<string, { text?: string; imageDataUrl?: string }> =
      {};
    for (const r of invite.savedFieldValues ?? []) {
      if (r.documentPartyId !== invite.documentPartyId) continue;
      if (r.textValue) initial[r.fieldId] = { text: r.textValue };
      else if (r.imagePresignedUrl)
        initial[r.fieldId] = { imageDataUrl: r.imagePresignedUrl };
    }
    setValues(initial);
  }, [invite]);

  useEffect(() => {
    if (!invite?.documentId) return;
    setPartPageCounts({});
    setPageSizes({});
    setPdfError(null);
    pageWrapRefs.current = [];
    setCurrentIndex(0);
    setFieldGuideDismissed({});
  }, [token, invite?.documentId, partsKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const styles = getComputedStyle(el);
      const pl = parseFloat(styles.paddingLeft) || 0;
      const pr = parseFloat(styles.paddingRight) || 0;
      const inner = el.clientWidth - pl - pr;
      setPageWidth(Math.min(720, Math.max(280, inner)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [invite?.documentId]);

  const onPartLoad = useCallback((partId: string, n: number) => {
    setPartPageCounts((prev) =>
      prev[partId] != null ? prev : { ...prev, [partId]: n },
    );
  }, []);

  const handleFieldClick = useCallback(
    (f: SigningFieldPayload) => {
      if (!invite) return;
      const idx = myFields.findIndex((x) => x.id === f.id);
      if (idx !== currentIndex) return;
      setFieldGuideDismissed((prev) => ({ ...prev, [f.id]: true }));
      if (f.type === "INITIALS") {
        const ini = deriveInitials(invite.signerName);
        setValues((prev) => ({
          ...prev,
          [f.id]: { ...prev[f.id], text: ini || prev[f.id]?.text },
        }));
        setCurrentIndex((i) => Math.min(i + 1, Math.max(myFields.length - 1, 0)));
        return;
      }
      if (fieldUsesImageModal(f.type)) {
        setSignatureLivePreview(null);
        setSigModalField(f);
        setSigModalOpen(true);
        return;
      }
      if (fieldUsesTextOnly(f.type)) {
        window.setTimeout(() => {
          document.getElementById("sign-field-input")?.focus();
        }, 0);
      }
    },
    [invite, myFields, currentIndex],
  );

  const handleSignatureModalPreview = useCallback(
    (url: string | null) => {
      if (!sigModalField) {
        setSignatureLivePreview(null);
        return;
      }
      if (!url) {
        setSignatureLivePreview(null);
        return;
      }
      setSignatureLivePreview({ fieldId: sigModalField.id, dataUrl: url });
    },
    [sigModalField],
  );

  const applySignatureFromModal = useCallback(
    async (pngDataUrl: string) => {
      if (!sigModalField) return;
      const compressed = await compressPngDataUrl(pngDataUrl);
      setSignatureLivePreview(null);
      setValues((prev) => ({
        ...prev,
        [sigModalField.id]: {
          ...prev[sigModalField.id],
          imageDataUrl: compressed,
        },
      }));
      setSigModalField(null);
      setSigModalOpen(false);
      setCurrentIndex((i) =>
        Math.min(i + 1, Math.max(myFields.length - 1, 0)),
      );
    },
    [sigModalField, myFields.length],
  );

  const currentField = myFields[currentIndex] ?? null;

  useEffect(() => {
    if (!currentField || !invite) return;
    if (currentField.type === "DATE") {
      setValues((prev) => {
        if (prev[currentField.id]?.text?.trim()) return prev;
        if (serverByFieldId[currentField.id]?.text) return prev;
        return {
          ...prev,
          [currentField.id]: {
            ...prev[currentField.id],
            text: new Date().toISOString().slice(0, 10),
          },
        };
      });
    }
    if (currentField.type === "INITIALS") {
      setValues((prev) => {
        if (prev[currentField.id]?.text?.trim()) return prev;
        if (serverByFieldId[currentField.id]?.text) return prev;
        const ini = deriveInitials(invite.signerName);
        if (!ini) return prev;
        return {
          ...prev,
          [currentField.id]: { ...prev[currentField.id], text: ini },
        };
      });
    }
  }, [currentField?.id, currentField?.type, invite, serverByFieldId]);

  const scrollToFieldPage = useCallback(
    (field: SigningFieldPayload) => {
      const pageIdx = field.pageNumber - 1;
      const el = pageWrapRefs.current[pageIdx];
      if (el && scrollRef.current) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    [],
  );

  useEffect(() => {
    if (currentField) scrollToFieldPage(currentField);
  }, [currentIndex, currentField, scrollToFieldPage]);

  const buildCompletions = () => {
    return myFields.map((f) => {
      const v = values[f.id];
      if (fieldUsesImageModal(f.type)) {
        const url = v?.imageDataUrl;
        if (!url) {
          throw new Error(`Please complete ${fieldTypeTitle(f.type)}.`);
        }
        const imageBase64 = url.includes(",")
          ? url.split(",", 2)[1]!
          : url;
        return { fieldId: f.id, imageBase64 };
      }
      let text = v?.text?.trim();
      if (!text && f.type === "DATE") {
        text = new Date().toISOString().slice(0, 10);
      }
      if (!text && f.type === "INITIALS") {
        text = invite ? deriveInitials(invite.signerName) : "";
      }
      if (!text) {
        throw new Error(`Please complete ${fieldTypeTitle(f.type)}.`);
      }
      return { fieldId: f.id, textValue: text };
    });
  };

  const handleSubmit = async () => {
    if (!token) return;
    let completions: {
      fieldId: string;
      textValue?: string;
      imageBase64?: string;
    }[];
    try {
      completions = buildCompletions();
    } catch (e) {
      toast({
        title: "Incomplete",
        description: e instanceof Error ? e.message : "Fill all fields.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `${config.apiUrl}/signing-complete/${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completions }),
        },
      );
      const raw = await res.text();
      let body: { message?: string } = {};
      if (raw) {
        try {
          body = JSON.parse(raw) as { message?: string };
        } catch {
          throw new Error(
            raw.length > 180 ? `${raw.slice(0, 180)}…` : raw || `HTTP ${res.status}`,
          );
        }
      }
      if (!res.ok) {
        throw new Error(
          body.message ??
            (res.status === 413
              ? "Request too large. Try a smaller signature or refresh the page."
              : `Could not complete signing (${res.status})`),
        );
      }
      toast({
        title: "Done",
        description: body.message ?? "Thank you — your signing is recorded.",
      });
    } catch (e: unknown) {
      let message = "Could not complete signing";
      if (e instanceof TypeError && e.message === "Failed to fetch") {
        message =
          "Network error: could not reach the server. Check that the app is running and REACT_APP_API_URL matches your API (same host/port as in dev).";
      } else if (e instanceof Error) {
        message = e.message;
      }
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => {
    if (myFields.length === 0) {
      void handleSubmit();
      return;
    }
    const cf = myFields[currentIndex];
    if (
      cf &&
      !isSigningFieldFilled(cf, values, serverByFieldId)
    ) {
      toast({
        title: "Incomplete",
        description: `Complete ${fieldTypeTitle(cf.type)} before continuing.`,
        variant: "destructive",
      });
      return;
    }
    if (currentIndex < myFields.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      void handleSubmit();
    }
  };

  const handleReject = async () => {
    if (!token) return;
    if (
      !window.confirm(
        "Decline to sign? The document owner will see that you declined.",
      )
    ) {
      return;
    }
    setRejecting(true);
    try {
      const res = await fetch(
        `${config.apiUrl}/signing-reject/${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      const body = (await res.json()) as { message?: string };
      if (!res.ok) {
        throw new Error(body.message ?? "Could not record your response");
      }
      toast({
        title: "Recorded",
        description: body.message ?? "You have declined to sign.",
      });
      setDeclined(true);
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Could not record your response";
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRejecting(false);
    }
  };

  if (!token) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">Invalid link.</p>
      </div>
    );
  }

  if (declined) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Declined</CardTitle>
            <CardDescription>
              Your decision has been recorded. You can close this page.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (invite === undefined && !loadError) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-6">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (loadError || invite == null) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Link not available</CardTitle>
            <CardDescription>
              This signing link is invalid, expired, or has already been used.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const inviterLine = invite.inviterEmail
    ? `${invite.inviterEmail} has invited you to sign this document.`
    : "You have been invited to sign this document.";

  return (
    <div className="bg-background flex h-[100dvh] min-h-0 flex-col">
      <header className="border-border flex shrink-0 flex-wrap items-start justify-between gap-4 border-b px-4 py-4 md:px-8">
        <div className="min-w-0">
          <h1 className="text-foreground truncate text-xl font-semibold tracking-tight md:text-2xl">
            {invite.documentName}
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            {inviterLine}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={rejecting}
          onClick={() => void handleReject()}
        >
          {rejecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Decline to sign"
          )}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="border-border min-h-0 flex-1 overflow-y-auto border-r bg-muted/20 px-4 py-6 md:px-8"
        >
          {pdfError ? (
            <p className="text-destructive text-sm">{pdfError}</p>
          ) : (
            parts.map((part, idx) =>
              canRenderPart(parts, idx, partPageCounts) ? (
                <SignPdfPartBlock
                  key={part.partId}
                  part={part}
                  globalPageOffset={globalOffsetForPart(
                    parts,
                    idx,
                    partPageCounts,
                  )}
                  pageWidth={pageWidth}
                  onPartLoad={onPartLoad}
                  pageWrapRefs={pageWrapRefs}
                  pageSizes={pageSizes}
                  setPageSizes={setPageSizes}
                  myFieldsInOrder={myFields}
                  currentIndex={currentIndex}
                  values={values}
                  serverByFieldId={serverByFieldId}
                  livePreview={signatureLivePreview}
                  fieldGuideDismissed={fieldGuideDismissed}
                  onFieldClick={handleFieldClick}
                  onPdfPartError={setPdfError}
                />
              ) : null,
            )
          )}
        </div>

        <aside className="border-border flex w-full max-w-md shrink-0 flex-col border-l bg-card">
          <div className="border-border shrink-0 border-b px-5 py-5">
            <h2 className="text-lg font-semibold">Sign document</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Please review the document before signing. You are signing as{" "}
              <strong>{invite.signerName}</strong> ({invite.partyLabel}).
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {myFields.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No fields are assigned to your role on this template. You can
                submit when ready.
              </p>
            ) : currentField ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Field {currentIndex + 1} of {myFields.length}
                  </span>
                  <span className="text-xs font-medium">
                    {fieldTypeTitle(currentField.type)}
                  </span>
                </div>

                {fieldUsesTextOnly(currentField.type) && (
                  <div className="space-y-2">
                    <Label htmlFor="sign-field-input">
                      {fieldTypeTitle(currentField.type)}
                    </Label>
                    {currentField.type === "DATE" ? (
                      <Input
                        id="sign-field-input"
                        type="date"
                        value={
                          values[currentField.id]?.text ??
                          serverByFieldId[currentField.id]?.text ??
                          new Date().toISOString().slice(0, 10)
                        }
                        onChange={(e) =>
                          setValues((prev) => ({
                            ...prev,
                            [currentField.id]: {
                              ...prev[currentField.id],
                              text: e.target.value,
                            },
                          }))
                        }
                      />
                    ) : (
                      <Input
                        id="sign-field-input"
                        value={
                          values[currentField.id]?.text ??
                          serverByFieldId[currentField.id]?.text ??
                          (currentField.type === "INITIALS"
                            ? deriveInitials(invite.signerName)
                            : "")
                        }
                        onChange={(e) =>
                          setValues((prev) => ({
                            ...prev,
                            [currentField.id]: {
                              ...prev[currentField.id],
                              text: e.target.value,
                            },
                          }))
                        }
                        placeholder={
                          currentField.type === "INITIALS"
                            ? "Initials"
                            : "Enter text"
                        }
                      />
                    )}
                  </div>
                )}

                {fieldUsesImageModal(currentField.type) && (
                  <div className="space-y-2">
                    <Label>{fieldTypeTitle(currentField.type)}</Label>
                    <div
                      className="border-border bg-muted/30 flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-3"
                      onClick={() => {
                        setSignatureLivePreview(null);
                        setFieldGuideDismissed((p) => ({
                          ...p,
                          [currentField.id]: true,
                        }));
                        setSigModalField(currentField);
                        setSigModalOpen(true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          setSignatureLivePreview(null);
                          setFieldGuideDismissed((p) => ({
                            ...p,
                            [currentField.id]: true,
                          }));
                          setSigModalField(currentField);
                          setSigModalOpen(true);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      {values[currentField.id]?.imageDataUrl ||
                      serverByFieldId[currentField.id]?.imageUrl ||
                      signatureLivePreview?.fieldId === currentField.id ? (
                        <img
                          src={
                            values[currentField.id]?.imageDataUrl ??
                            serverByFieldId[currentField.id]?.imageUrl ??
                            signatureLivePreview?.dataUrl
                          }
                          alt="Signature"
                          className="max-h-28 w-full object-contain"
                        />
                      ) : (
                        <span className="text-muted-foreground text-sm">
                          Click to sign — Draw, type, or upload
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="border-border mt-auto flex shrink-0 gap-3 border-t px-5 py-4">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              disabled={rejecting || submitting}
              onClick={() => void handleReject()}
            >
              {rejecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Decline"
              )}
            </Button>
            <Button
              type="button"
              className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={submitting || rejecting}
              onClick={() => void handleNext()}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : myFields.length === 0 || currentIndex >= myFields.length - 1 ? (
                "Finish signing"
              ) : (
                "Next field"
              )}
            </Button>
          </div>
        </aside>
      </div>

      <SignatureCaptureModal
        open={sigModalOpen}
        onOpenChange={(open) => {
          setSigModalOpen(open);
          if (!open) {
            setSigModalField(null);
            setSignatureLivePreview(null);
          }
        }}
        title={
          sigModalField
            ? `Add ${fieldTypeTitle(sigModalField.type).toLowerCase()}`
            : "Add signature"
        }
        onPreview={handleSignatureModalPreview}
        onApply={(dataUrl) => void applySignatureFromModal(dataUrl)}
      />
    </div>
  );
}
