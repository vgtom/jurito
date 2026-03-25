import { type Document } from "wasp/entities";
import { deleteDocument, getDocuments, useQuery } from "wasp/client/operations";
import { Link, routes } from "wasp/client/router";
import { Eye, Loader2, Trash2 } from "lucide-react";

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
import { toast } from "../client/hooks/use-toast";

function statusBadgeVariant(
  status: Document["status"],
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

function formatCreatedAt(createdAt: Date | string): string {
  const d = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function DocumentsTable() {
  const { data: documents, isLoading, refetch, error } = useQuery(getDocuments);

  const handleDelete = async (doc: Document) => {
    if (
      !window.confirm(
        `Delete “${doc.name}”? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await deleteDocument({ documentId: doc.id });
      toast({ title: "Document deleted" });
      await refetch();
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Delete failed";
      toast({
        title: "Could not delete",
        description: message,
        variant: "destructive",
      });
    }
  };

  if (error) {
    return (
      <p className="text-destructive text-sm">
        Could not load documents: {String(error)}
      </p>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Document</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={4}>
                <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading documents…
                </div>
              </TableCell>
            </TableRow>
          )}
          {!isLoading && documents && documents.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={4}
                className="text-muted-foreground py-8 text-center text-sm"
              >
                No documents yet. Upload a PDF to get started.
              </TableCell>
            </TableRow>
          )}
          {!isLoading &&
            documents?.map((doc) => (
              <TableRow key={doc.id}>
                <TableCell className="max-w-[220px] truncate font-medium">
                  {doc.name}
                </TableCell>
                <TableCell>
                  <Badge variant={statusBadgeVariant(doc.status)}>
                    {doc.status.toLowerCase()}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  {formatCreatedAt(doc.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" asChild>
                      <Link
                        to={routes.DocumentEditorRoute.to}
                        params={{ documentId: doc.id }}
                      >
                        <Eye className="mr-1 h-4 w-4" />
                        View
                      </Link>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void handleDelete(doc)}
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  );
}
