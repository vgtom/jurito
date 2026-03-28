import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { config } from "wasp/client";

import { Button } from "../client/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../client/components/ui/card";
import { toast } from "../client/hooks/use-toast";

type SigningInvitePayload = {
  documentName: string;
  partyLabel: string;
  signerName: string;
};

export default function SignDocumentPage() {
  const { token } = useParams<{ token: string }>();
  const [submitting, setSubmitting] = useState(false);
  const [invite, setInvite] = useState<SigningInvitePayload | null | undefined>(
    undefined,
  );
  const [loadError, setLoadError] = useState(false);

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
      setInvite(data);
    } catch {
      setLoadError(true);
      setInvite(null);
    }
  }, [token]);

  useEffect(() => {
    void loadInvite();
  }, [loadInvite]);

  const handleComplete = async () => {
    if (!token) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `${config.apiUrl}/signing-complete/${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      const body = (await res.json()) as { message?: string };
      if (!res.ok) {
        throw new Error(body.message ?? "Could not record signing");
      }
      toast({
        title: "Done",
        description: body.message ?? "Signing recorded. Thank you.",
      });
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Could not record signing";
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">Invalid link.</p>
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

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{invite.documentName}</CardTitle>
          <CardDescription>
            You are signing as <strong>{invite.signerName}</strong> (
            {invite.partyLabel}).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            After you have reviewed the document and completed any required
            fields, confirm below so the next signer can be notified when
            applicable.
          </p>
          <Button
            type="button"
            className="w-full"
            disabled={submitting}
            onClick={() => void handleComplete()}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Submitting…
              </>
            ) : (
              "I have finished signing"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
