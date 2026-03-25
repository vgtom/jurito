import { useAuth } from "wasp/client/auth";
import { createDocument, getDocuments, useQuery } from "wasp/client/operations";

import { FileUp, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

import { PremiumFeature } from "../client/components/billing/PremiumFeature";
import { Button } from "../client/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../client/components/ui/card";
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

export function DocumentUploader() {
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
        });
        toast({ title: "Document uploaded", description: file.name });
        await refetch();
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
    [refetch],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxFiles: 1,
    disabled: isUploading,
  });

  return (
    <Card className="bg-muted/10">
      <CardHeader>
        <CardTitle>Documents</CardTitle>
        <CardDescription>
          Upload PDFs for e-signing. Free plan: 1 document; Pro: unlimited.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <PremiumFeature gated={uploadGated}>
          <div
            {...getRootProps()}
            className={cn(
              "border-muted-foreground/25 hover:border-primary/50 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 transition-colors",
              isDragActive && "border-primary bg-primary/5",
              isUploading && "pointer-events-none opacity-60",
            )}
          >
            <input {...getInputProps()} />
            {isUploading ? (
              <Loader2 className="text-muted-foreground h-10 w-10 animate-spin" />
            ) : (
              <FileUp className="text-muted-foreground mb-2 h-10 w-10" />
            )}
            <p className="text-muted-foreground text-center text-sm">
              {isDragActive
                ? "Drop the PDF here"
                : "Drag a PDF here, or click to choose a file"}
            </p>
          </div>
        </PremiumFeature>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isUploading}
          onClick={() => refetch()}
        >
          Refresh list
        </Button>
      </CardContent>
    </Card>
  );
}
