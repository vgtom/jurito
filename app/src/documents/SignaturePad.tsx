import { saveSignatureImage } from "wasp/client/operations";
import { Eraser, Save } from "lucide-react";
import { useRef, useState } from "react";
import SignatureCanvas from "react-signature-canvas";

import { Button } from "../client/components/ui/button";
import { toast } from "../client/hooks/use-toast";

type Props = {
  onSaved?: () => void;
};

export function SignaturePad({ onSaved }: Props) {
  const sigRef = useRef<SignatureCanvas>(null);
  const [saving, setSaving] = useState(false);

  const clear = () => {
    sigRef.current?.clear();
  };

  const save = async () => {
    if (!sigRef.current || sigRef.current.isEmpty()) {
      toast({
        title: "Nothing to save",
        description: "Draw your signature first.",
        variant: "destructive",
      });
      return;
    }

    const trimmed = sigRef.current.getTrimmedCanvas();
    const dataUrl = trimmed.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];
    if (!base64) {
      toast({
        title: "Invalid image",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      await saveSignatureImage({ imageBase64: base64 });
      onSaved?.();
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Could not save signature";
      toast({ title: "Save failed", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-muted/50 rounded-md border">
        <SignatureCanvas
          ref={sigRef}
          canvasProps={{
            className: "w-full max-w-xl touch-none",
            style: { height: 160, width: "100%" },
          }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={clear}>
          <Eraser className="mr-1 h-4 w-4" />
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={() => void save()}
        >
          <Save className="mr-1 h-4 w-4" />
          {saving ? "Saving…" : "Save signature"}
        </Button>
      </div>
    </div>
  );
}
