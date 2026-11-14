"use client";

import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, undeletablePath } from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ChevronRight,
  CloudOff,
  Download,
  Eye,
  Folder,
  FolderOpen,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import type { FileListing } from "@open-bot/api/worker";
import { isOffline } from "@/lib/client/errors";
import { useAppState, useComputerOnline } from "@/features/app-shell";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import { uploadToFolder } from "../uploads";
import { TeammateAvatar } from "@/components/teammate-avatar";
import { useFolder } from "../hooks";
import { FileIcon } from "./file-chip";
import { FilePreview } from "./file-preview";
import { fileKind, fileUrl } from "@/lib/files";
import { cn } from "@/lib/utils";

const ROOT = "/home/bot";

function icon(name: string, isDirectory: boolean) {
  if (isDirectory) return <Folder className="size-4 text-muted-foreground" />;
  return <FileIcon name={name} className="size-4 text-muted-foreground" />;
}

function DeleteEntry({
  entry,
  label,
  onDeleted,
}: {
  entry: FileListing["entries"][number];
  label: string;
  onDeleted: () => void;
}) {
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${entry.name}`}>
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Delete</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {entry.isDirectory
              ? "The folder and everything in it are removed from the computer."
              : "The file is removed from the computer."}{" "}
            This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              const result = await attempt(api.files.remove({ path: entry.path }));
              if (!result.ok)
                toast.error(`Couldn't delete ${entry.name}`, { description: result.error });
              onDeleted();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function FilesView() {
  const [path, setPath] = useState(ROOT);
  // The path stays while the preview closes, so it doesn't go blank as it fades.
  const [preview, setPreview] = useState({ path: "", open: false });
  const setPreviewing = (path: string) => setPreview({ path, open: true });
  const { data: state } = useAppState();
  const online = useComputerOnline();
  const { data, isLoading, error } = useFolder(path, online !== false);
  const offline = online === false || isOffline(error);
  const parts = path.slice(ROOT.length).split("/").filter(Boolean);
  const teammateBySlug = (slug: string) =>
    state?.teammates.find((teammate) => teammate.slug === slug);
  const teammateSlugs = new Set(state?.teammates.map((teammate) => teammate.slug) ?? []);
  const queryClient = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const canUpload = path !== ROOT;
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: orpc.files.list.key({ input: { path } }) });

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    const tooBig = list.filter((file) => file.size > MAX_UPLOAD_BYTES);
    for (const file of tooBig)
      toast.error(`Couldn't upload ${file.name}`, {
        description: `Files can be up to ${MAX_UPLOAD_LABEL}.`,
      });
    const ok = list.filter((file) => file.size <= MAX_UPLOAD_BYTES);
    if (ok.length === 0) return;
    setUploading((n) => n + ok.length);
    let done = 0;
    // One at a time, so each stays under the upload size limit.
    for (const file of ok) {
      const result = await uploadToFolder(path, file);
      setUploading((n) => n - 1);
      if (result.ok) done += 1;
      else toast.error(`Couldn't upload ${file.name}`, { description: result.error });
    }
    if (done > 0) toast(done === 1 ? "Uploaded 1 file" : `Uploaded ${done} files`);
    refresh();
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (canUpload && event.dataTransfer.files.length) void upload(event.dataTransfer.files);
  }

  const entries = [...(data?.entries ?? [])].sort((a, b) =>
    a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 text-[14px]">
          <button
            onClick={() => setPath(ROOT)}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium hover:bg-muted"
          >
            <FolderOpen className="size-4" /> Computer
          </button>
          {parts.map((part, index) => {
            const target = `${ROOT}/${parts.slice(0, index + 1).join("/")}`;
            return (
              <span key={target} className="flex items-center gap-1">
                <ChevronRight className="size-3.5 text-muted-foreground" />
                <button
                  onClick={() => setPath(target)}
                  className="rounded-md px-1.5 py-0.5 hover:bg-muted"
                >
                  {index === 1 && parts[0] === "bots" && teammateBySlug(part)
                    ? `${teammateBySlug(part)!.name}'s workspace`
                    : part}
                </button>
              </span>
            );
          })}
        </nav>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files?.length) void upload(event.target.files);
            event.target.value = "";
          }}
          data-testid="files-input"
        />
        {canUpload && (
          <Button variant="outline" size="sm" onClick={() => picker.current?.click()}>
            {uploading > 0 ? <Loader2 className="animate-spin" /> : <Upload />}
            {uploading > 0 ? `Uploading ${uploading}…` : "Upload"}
          </Button>
        )}
      </div>
      <div
        className={cn(
          "relative overflow-hidden rounded-xl bg-card shadow-raised transition-colors",
          dragging && "border-foreground/40",
        )}
        onDragOver={(event) => {
          if (!canUpload || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-card/85 text-[14px] font-medium backdrop-blur-[1px]">
            <Upload className="mr-2 size-4" />
            Drop to upload to {parts.at(-1) ?? "this folder"}
          </div>
        )}
        {offline ? (
          <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
            <CloudOff className="mb-1 size-5 text-muted-foreground" />
            <p className="text-[14px] font-medium">The computer is offline</p>
            <p className="max-w-sm text-[13px] text-muted-foreground">
              Its files show here once it&apos;s back. This updates by itself.
            </p>
          </div>
        ) : isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-1/3" />
          </div>
        ) : error ? (
          <p className="px-4 py-8 text-center text-[14px] text-muted-foreground">
            {(error as Error).message}
          </p>
        ) : entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-[14px] text-muted-foreground">
            This folder is empty.{canUpload && " Drop files here to upload them."}
          </p>
        ) : (
          <ul className="divide-y">
            {entries.map((entry) => {
              const teammate =
                path === `${ROOT}/bots` && entry.isDirectory
                  ? teammateBySlug(entry.name)
                  : undefined;
              return (
                <li
                  key={entry.path}
                  className="group flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40"
                >
                  {teammate ? (
                    <TeammateAvatar
                      name={teammate.name}
                      color={teammate.color}
                      emoji={teammate.emoji}
                      size="xs"
                    />
                  ) : (
                    icon(entry.name, entry.isDirectory)
                  )}
                  {entry.isDirectory ? (
                    <button
                      onClick={() => setPath(entry.path)}
                      className="flex-1 truncate text-left text-[14px] hover:underline"
                    >
                      {teammate ? `${teammate.name}'s workspace` : entry.name}
                    </button>
                  ) : fileKind(entry.name) === "other" ? (
                    <span className="flex-1 truncate text-[14px]">{entry.name}</span>
                  ) : (
                    <button
                      onClick={() => setPreviewing(entry.path)}
                      className="flex-1 truncate text-left text-[14px] hover:underline"
                    >
                      {entry.name}
                    </button>
                  )}
                  {entry.modifiedAt && (
                    <span className="hidden text-[12.5px] text-muted-foreground sm:block">
                      {formatDistanceToNowStrict(new Date(entry.modifiedAt), { addSuffix: true })}
                    </span>
                  )}
                  <span className="flex min-h-7 items-center gap-0.5">
                    {!entry.isDirectory && (
                      <>
                        {fileKind(entry.name) !== "other" && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Preview ${entry.name}`}
                            onClick={() => setPreviewing(entry.path)}
                          >
                            <Eye />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          asChild
                          aria-label={`Download ${entry.name}`}
                        >
                          <a href={fileUrl(entry.path)}>
                            <Download />
                          </a>
                        </Button>
                      </>
                    )}
                    {!undeletablePath(entry.path, teammateSlugs) && (
                      <DeleteEntry
                        entry={entry}
                        label={teammate ? `${teammate.name}'s workspace` : entry.name}
                        onDeleted={refresh}
                      />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        Each teammate has a workspace under <code className="font-mono">bots</code>.{" "}
        <code className="font-mono">shared</code> is for everyone, and browser downloads land in{" "}
        <code className="font-mono">shared/downloads</code>.
      </p>
      {preview.path && (
        <FilePreview
          path={preview.path}
          open={preview.open}
          onOpenChange={(open) => setPreview((current) => ({ ...current, open }))}
        />
      )}
    </div>
  );
}
