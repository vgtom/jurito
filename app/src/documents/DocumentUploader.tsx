import { type DocumentFolder } from "wasp/entities";
import { useAuth } from "wasp/client/auth";
import { createDocument, getDocuments, useQuery } from "wasp/client/operations";

import { FileUp, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

import { PremiumFeature } from "../client/components/billing/PremiumFeature";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../client/components/ui/card";
import { Label } from "../client/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../client/components/ui/select";
import { toast } from "../client/hooks/use-toast";
import { cn } from "../client/utils";

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

type DocumentUploaderProps = {
  folders: DocumentFolder[];
  uploadFolderId: string | undefined;
  onUploadFolderChange: (id: string) => void;
  onUploaded?: () => void;
  /** Tighter layout for the dashboard workspace. */
  compact?: boolean;
};

export function DocumentUploader({
  folders,
  uploadFolderId,
  onUploadFolderChange,
  onUploaded,
  compact = false,
}: DocumentUploaderProps) {
  const { data: user } = useAuth();
  const { data: documents, refetch } = useQuery(getDocuments);
  const [isUploading, setIsUploading] = useState(false);

  const uploadGated =
    !!user &&
    !user.isAdmin &&
    user.plan === "FREE" &&
    (documents?.length ?? 0) >= 1;

  const onDrop = useCallback(
    async (accepted: File[]) => {
      const file = accepted[0];
      if (!file) return;

      setIsUploading(true);
      try {
        const fileBase64 = await fileToBase64(file);
        await createDocument({
          fileName: file.name,
          fileBase64,
          contentType: "application/pdf",
          ...(uploadFolderId ? { folderId: uploadFolderId } : {}),
        });
        toast({ title: "Document uploaded", description: file.name });
        await refetch();
        onUploaded?.();
      } catch (e: unknown) {
        const message =
          e && typeof e === "object" && "message" in e
            ? String((e as { message: string }).message)
            : "Upload failed";
        toast({
          title: "Upload failed",
          description: message,
          variant: "destructive",
        });
      } finally {
        setIsUploading(false);
      }
    },
    [refetch, uploadFolderId, onUploaded],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxFiles: 1,
    disabled: isUploading,
  });

  return (
    <Card
      className={cn(
        "border-border/80 from-card/90 to-muted/20 shrink-0 bg-gradient-to-br shadow-sm",
        compact ? "p-0" : "bg-muted/10",
      )}
    >
      <CardHeader className={cn(compact ? "space-y-1 px-4 pb-2 pt-4" : "")}>
        <CardTitle className={cn(compact ? "text-base" : "")}>
          Upload template
        </CardTitle>
        <CardDescription className={cn(compact ? "text-xs" : "")}>
          PDFs go to the selected folder. Free plan: 1 document; Pro: unlimited.
        </CardDescription>
      </CardHeader>
      <CardContent
        className={cn(
          "space-y-6",
          compact ? "space-y-4 px-4 pb-3 pt-0" : "",
        )}
      >
        <div
          className={cn(
            "gap-4",
            compact && folders.length > 0
              ? "grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,14rem)_1fr] lg:items-stretch"
              : "flex flex-col",
          )}
        >
          {folders.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="upload-folder" className={compact ? "text-xs" : ""}>
                Save to folder
              </Label>
              <Select
                value={uploadFolderId ?? ""}
                onValueChange={onUploadFolderChange}
              >
                <SelectTrigger id="upload-folder" className={compact ? "h-9" : ""}>
                  <SelectValue placeholder="Choose folder" />
                </SelectTrigger>
                <SelectContent>
                  {folders.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <PremiumFeature gated={uploadGated}>
            <div
              {...getRootProps()}
              className={cn(
                "border-muted-foreground/25 hover:border-primary/50 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 transition-colors",
                compact ? "py-6 md:py-7" : "px-6 py-10",
                isDragActive && "border-primary bg-primary/5",
                isUploading && "pointer-events-none opacity-60",
              )}
            >
              <input {...getInputProps()} />
              {isUploading ? (
                <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
              ) : (
                <FileUp
                  className={cn(
                    "text-muted-foreground mb-1",
                    compact ? "h-8 w-8" : "mb-2 h-10 w-10",
                  )}
                />
              )}
              <p
                className={cn(
                  "text-muted-foreground text-center",
                  compact ? "text-xs" : "text-sm",
                )}
              >
                {isDragActive
                  ? "Drop the PDF here"
                  : "Drag a PDF here, or click to choose"}
              </p>
            </div>
          </PremiumFeature>
        </div>
      </CardContent>
    </Card>
  );
}
