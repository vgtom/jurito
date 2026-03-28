import { getDocumentSubmissions, useQuery } from "wasp/client/operations";
import { Link, routes } from "wasp/client/router";
import { Eye, Loader2 } from "lucide-react";

import { Badge } from "../client/components/ui/badge";
import { Button } from "../client/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../client/components/ui/table";

function statusBadgeVariant(
  status: "DRAFT" | "SENT" | "SIGNED",
): "secondary" | "default" | "success" {
  switch (status) {
    case "DRAFT":
      return "secondary";
    case "SENT":
      return "default";
    case "SIGNED":
      return "success";
    default:
      return "secondary";
  }
}

function formatDate(d: Date | string | null | undefined): string {
  if (d == null) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SubmissionsTable() {
  const { data: submissions, isLoading, error } = useQuery(
    getDocumentSubmissions,
  );

  if (error) {
    return (
      <p className="text-destructive text-sm">
        Could not load submissions: {String(error)}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border/70 from-muted/20 to-card/40 relative min-h-[min(42rem,calc(100dvh-10rem))] flex-1 overflow-auto rounded-xl border bg-gradient-to-b shadow-inner">
        <Table>
          <TableHeader className="bg-background/95 sticky top-0 z-10 backdrop-blur-sm [&_tr]:border-b">
            <TableRow className="border-border/80 hover:bg-transparent">
              <TableHead className="whitespace-nowrap">Document</TableHead>
              <TableHead className="min-w-[280px] whitespace-nowrap">
                Signing progress
              </TableHead>
              <TableHead className="whitespace-nowrap">Sent</TableHead>
              <TableHead className="text-right whitespace-nowrap">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={4}>
                  <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading submissions…
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!isLoading && submissions && submissions.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-muted-foreground py-8 text-center text-sm"
                >
                  No submissions yet. Send a template from the editor to see it
                  here.
                </TableCell>
              </TableRow>
            )}
            {!isLoading &&
              submissions?.map((doc) => (
                <TableRow key={doc.id} className="hover:bg-muted/40">
                  <TableCell className="max-w-[240px] truncate py-2.5 font-medium">
                    {doc.name}
                  </TableCell>
                  <TableCell className="max-w-xl py-2.5 align-top">
                    <div className="flex flex-col gap-2">
                      <Badge
                        variant={statusBadgeVariant(doc.status)}
                        className="w-fit capitalize"
                      >
                        {doc.status.toLowerCase()}
                      </Badge>
                      {doc.parties.length === 0 ? (
                        <span className="text-muted-foreground text-xs">—</span>
                      ) : (
                        <ul className="text-muted-foreground space-y-1 text-xs leading-snug">
                          {doc.parties.map((p) => (
                            <li key={p.id}>{p.statusSummary}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap py-2.5">
                    {formatDate(doc.sentAt ?? doc.createdAt)}
                  </TableCell>
                  <TableCell className="py-2.5 text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link
                        to={routes.DocumentPreviewRoute.to}
                        params={{ documentId: doc.id }}
                      >
                        <Eye className="mr-1 h-4 w-4" />
                        View
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
