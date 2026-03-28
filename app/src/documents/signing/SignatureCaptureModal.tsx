import { useRef, useState } from "react";
import SignatureCanvas from "react-signature-canvas";

import { Button } from "../../client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../client/components/ui/dialog";
import { Input } from "../../client/components/ui/input";
import { Label } from "../../client/components/ui/label";
import { cn } from "../../client/utils";

type Tab = "draw" | "type" | "upload";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  onApply: (pngDataUrl: string) => void;
};

function textToPngDataUrl(text: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 560;
  canvas.height = 200;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0a0a0a";
  ctx.font =
    '52px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive';
  ctx.textBaseline = "middle";
  const t = text.trim() || " ";
  ctx.fillText(t, 24, canvas.height / 2);
  return canvas.toDataURL("image/png");
}

export function SignatureCaptureModal({
  open,
  onOpenChange,
  title = "Add signature",
  onApply,
}: Props) {
  const [tab, setTab] = useState<Tab>("draw");
  const [typed, setTyped] = useState("");
  const sigRef = useRef<SignatureCanvas>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const applyDraw = () => {
    if (!sigRef.current || sigRef.current.isEmpty()) return;
    const trimmed = sigRef.current.getTrimmedCanvas();
    onApply(trimmed.toDataURL("image/png"));
    onOpenChange(false);
    sigRef.current.clear();
  };

  const applyType = () => {
    const url = textToPngDataUrl(typed);
    if (!url) return;
    onApply(url);
    onOpenChange(false);
    setTyped("");
  };

  const applyUpload = () => {
    fileInputRef.current?.click();
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const w = Math.min(img.width, 800);
        const h = Math.min(img.height, 400);
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        onApply(canvas.toDataURL("image/png"));
        onOpenChange(false);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg border bg-muted/30 p-1">
          {(
            [
              ["draw", "Draw"],
              ["type", "Type"],
              ["upload", "Upload"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                tab === id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "draw" && (
          <div className="space-y-2">
            <div className="bg-muted/50 rounded-md border">
              <SignatureCanvas
                ref={sigRef}
                canvasProps={{
                  className: "w-full touch-none rounded-md",
                  style: { height: 180, width: "100%" },
                }}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => sigRef.current?.clear()}
            >
              Clear
            </Button>
          </div>
        )}

        {tab === "type" && (
          <div className="space-y-2">
            <Label htmlFor="sig-type-input">Type your name</Label>
            <Input
              id="sig-type-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Your name"
              autoComplete="name"
            />
            <p className="text-muted-foreground text-xs">
              We render it as an image in a script style for the document.
            </p>
          </div>
        )}

        {tab === "upload" && (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              Upload a PNG or JPG image of your signature. It will be converted
              to PNG.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => onFileChange(e)}
            />
            <Button type="button" variant="outline" onClick={applyUpload}>
              Choose image…
            </Button>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {tab === "draw" && (
            <Button type="button" onClick={applyDraw}>
              Apply signature
            </Button>
          )}
          {tab === "type" && (
            <Button
              type="button"
              onClick={applyType}
              disabled={!typed.trim()}
            >
              Apply signature
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
