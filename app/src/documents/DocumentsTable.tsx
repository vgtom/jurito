import { useMemo, useState } from "react";
import { type Document, type DocumentFolder } from "wasp/entities";
import {
  deleteDocument,
  duplicateDocument,
  getDocuments,
  getFolders,
  moveDocumentToFolder,
  useQuery,
} from "wasp/client/operations";
import { Link, routes } from "wasp/client/router";
import { Copy, Eye, Loader2, MoreHorizontal, Trash2 } from "lucide-react";

import { Badge } from "../client/components/ui/badge";
import { Button } from "../client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../client/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../client/components/ui/table";
import { toast } from "../client/hooks/use-toast";
import { cn } from "../client/utils";

type DocumentWithFolder = Document & { folder: DocumentFolder };

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

type DocumentsTableProps = {
  folderFilter: "all" | string;
  className?: string;
};

export function DocumentsTable({ folderFilter, className }: DocumentsTableProps) {
  const { data: documents, isLoading, refetch, error } = useQuery(getDocuments);
  const { data: folders } = useQuery(getFolders);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!documents) return [];
    if (folderFilter === "all") return documents as DocumentWithFolder[];
    return (documents as DocumentWithFolder[]).filter(
      (d) => d.folderId === folderFilter,
    );
  }, [documents, folderFilter]);

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

  const handleDuplicate = async (doc: Document) => {
    setDuplicatingId(doc.id);
    try {
      await duplicateDocument({ documentId: doc.id });
      toast({
        title: "Duplicate created",
        description: `A copy of “${doc.name}” was added with a new PDF in storage.`,
      });
      await refetch();
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Duplicate failed";
      toast({
        title: "Could not duplicate",
        description: message,
        variant: "destructive",
      });
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleMove = async (doc: DocumentWithFolder, folderId: string) => {
    if (doc.folderId === folderId) return;
    try {
      await moveDocumentToFolder({ documentId: doc.id, folderId });
      toast({ title: "Moved", description: `Document moved to folder.` });
      await refetch();
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Move failed";
      toast({
        title: "Could not move",
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

  const otherFolders = (fid: string) =>
    (folders ?? []).filter((f) => f.id !== fid);

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        className,
      )}
    >
      <div className="border-border/70 from-muted/20 to-card/40 relative min-h-[min(40rem,calc(100dvh-10.5rem))] flex-1 overflow-auto rounded-xl border bg-gradient-to-b shadow-inner">
        <Table>
          <TableHeader className="bg-background/95 sticky top-0 z-10 backdrop-blur-sm [&_tr]:border-b [&_tr:hover]:bg-transparent">
            <TableRow className="border-border/80 hover:bg-transparent">
              <TableHead className="whitespace-nowrap">Document</TableHead>
              <TableHead className="whitespace-nowrap">Folder</TableHead>
              <TableHead className="whitespace-nowrap">Status</TableHead>
              <TableHead className="whitespace-nowrap">Created</TableHead>
              <TableHead className="text-right whitespace-nowrap">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={5}>
                <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading documents…
                </div>
              </TableCell>
            </TableRow>
          )}
          {!isLoading && rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={5}
                className="text-muted-foreground py-8 text-center text-sm"
              >
                No documents in this view. Upload a PDF or pick another folder.
              </TableCell>
            </TableRow>
          )}
          {!isLoading &&
            rows.map((doc) => (
              <TableRow key={doc.id} className="hover:bg-muted/40">
                <TableCell className="max-w-[200px] truncate py-2.5 font-medium">
                  {doc.name}
                </TableCell>
                <TableCell className="text-muted-foreground max-w-[140px] truncate py-2.5 text-sm">
                  {doc.folder?.name ?? "—"}
                </TableCell>
                <TableCell className="py-2.5">
                  <Badge variant={statusBadgeVariant(doc.status)}>
                    {doc.status.toLowerCase()}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap py-2.5">
                  {formatCreatedAt(doc.createdAt)}
                </TableCell>
                <TableCell className="py-2.5 text-right">
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
                      disabled={duplicatingId === doc.id}
                      onClick={() => void handleDuplicate(doc)}
                      title="Duplicate template (new PDFs in storage)"
                    >
                      {duplicatingId === doc.id ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Copy className="mr-1 h-4 w-4" />
                      )}
                      Duplicate
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          aria-label="More actions"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {otherFolders(doc.folderId).length === 0 ? (
                          <DropdownMenuItem disabled>
                            No other folders
                          </DropdownMenuItem>
                        ) : (
                          otherFolders(doc.folderId).map((f) => (
                            <DropdownMenuItem
                              key={f.id}
                              onClick={() => void handleMove(doc, f.id)}
                            >
                              Move to {f.name}
                            </DropdownMenuItem>
                          ))
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
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
    </div>
  );
}
