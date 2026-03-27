import { useEffect, useState } from "react";
import { createFolder, getFolders, useQuery } from "wasp/client/operations";
import { FolderInput, FolderPlus, Loader2 } from "lucide-react";

import { Button } from "../client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../client/components/ui/dialog";
import { Input } from "../client/components/ui/input";
import { Label } from "../client/components/ui/label";
import { toast } from "../client/hooks/use-toast";
import { DocumentUploader } from "./DocumentUploader";
import { DocumentsTable } from "./DocumentsTable";

const DEFAULT_FOLDER_NAME = "MyFolder";

export function DocumentTemplatesSection() {
  const { data: folders, isLoading: foldersLoading, refetch: refetchFolders } =
    useQuery(getFolders);

  const [folderFilter, setFolderFilter] = useState<"all" | string>("all");
  const [uploadFolderId, setUploadFolderId] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!folders?.length) return;
    setUploadFolderId((prev) => {
      if (prev && folders.some((f) => f.id === prev)) return prev;
      return (
        folders.find((f) => f.name === DEFAULT_FOLDER_NAME)?.id ??
        folders[0]!.id
      );
    });
  }, [folders]);

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      toast({
        title: "Name required",
        variant: "destructive",
      });
      return;
    }
    setCreating(true);
    try {
      await createFolder({ name });
      toast({ title: "Folder created", description: name });
      setNewFolderName("");
      setCreateOpen(false);
      await refetchFolders();
    } catch (e: unknown) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : "Could not create folder";
      toast({
        title: "Could not create folder",
        description: message,
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-6">
      <aside className="border-border bg-card/60 w-full shrink-0 rounded-xl border p-4 shadow-sm lg:sticky lg:top-0 lg:max-h-[min(100%,calc(100dvh-8rem))] lg:w-56 lg:self-start lg:overflow-y-auto">
        <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase tracking-wider">
          Folders
        </p>
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant={folderFilter === "all" ? "secondary" : "ghost"}
            size="sm"
            className="justify-start font-normal"
            onClick={() => setFolderFilter("all")}
          >
            All templates
          </Button>
          {foldersLoading && (
            <div className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          )}
          {!foldersLoading &&
            folders?.map((f) => (
              <Button
                key={f.id}
                type="button"
                variant={folderFilter === f.id ? "secondary" : "ghost"}
                size="sm"
                className="h-auto min-h-9 justify-start py-2 text-left font-normal"
                onClick={() => setFolderFilter(f.id)}
              >
                <FolderInput className="text-muted-foreground mr-2 h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{f.name}</span>
              </Button>
            ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4 w-full"
          onClick={() => setCreateOpen(true)}
        >
          <FolderPlus className="mr-1 h-4 w-4" />
          New folder
        </Button>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <DocumentUploader
          compact
          folders={folders ?? []}
          uploadFolderId={uploadFolderId}
          onUploadFolderChange={setUploadFolderId}
          onUploaded={() => void refetchFolders()}
        />
        <DocumentsTable folderFilter={folderFilter} />
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder to organize templates. Names must be unique in
              your account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="folder-name">Folder name</Label>
            <Input
              id="folder-name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="e.g. Client agreements"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateFolder();
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={creating || !newFolderName.trim()}
              onClick={() => void handleCreateFolder()}
            >
              {creating ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
