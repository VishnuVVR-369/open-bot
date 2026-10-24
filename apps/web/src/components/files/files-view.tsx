"use client";

import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, undeletablePath } from "@open-bot/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ChevronRight,
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
import { removeFile, uploadFile } from "@/lib/actions";
import { Skeleton } from "@/components/ui/skeleton";
import { getJson } from "@/lib/client/api";
import { queryKeys, useAppState } from "@/lib/client/queries";
import { BotAvatar } from "@/components/bot-avatar";
import { FileIcon } from "@/components/files/file-chip";
import { FilePreview } from "@/components/files/file-preview";
import { fileKind, fileUrl } from "@/lib/files";
import { cn } from "@/lib/utils";

interface Listing {
  path: string;
  entries: { name: string; path: string; isDirectory: boolean; modifiedAt: string | null }[];
}

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
  entry: Listing["entries"][number];
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
              const result = await removeFile(entry.path);
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
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.files(path),
    queryFn: () => getJson<Listing>(`/api/files/list?path=${encodeURIComponent(path)}`),
  });
  const parts = path.slice(ROOT.length).split("/").filter(Boolean);
  const botBySlug = (slug: string) => state?.bots.find((bot) => bot.slug === slug);
  const botSlugs = new Set(state?.bots.map((bot) => bot.slug) ?? []);
  const queryClient = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const canUpload = path !== ROOT;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.files(path) });

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
      const form = new FormData();
      form.set("file", file);
      const result = await uploadFile(path, form).catch(() => null);
      setUploading((n) => n - 1);
      if (result?.ok) done += 1;
      else
        toast.error(`Couldn't upload ${file.name}`, {
          description: result?.error ?? "The upload didn't go through. Try again.",
        });
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
                  {index === 1 && parts[0] === "bots" && botBySlug(part)
                    ? `${botBySlug(part)!.name}'s workspace`
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
          "relative overflow-hidden rounded-xl border bg-card transition-colors",
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
        {isLoading ? (
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
              const bot =
                path === `${ROOT}/bots` && entry.isDirectory ? botBySlug(entry.name) : undefined;
              return (
                <li
                  key={entry.path}
                  className="group flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40"
                >
                  {bot ? (
                    <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="xs" />
                  ) : (
                    icon(entry.name, entry.isDirectory)
                  )}
                  {entry.isDirectory ? (
                    <button
                      onClick={() => setPath(entry.path)}
                      className="flex-1 truncate text-left text-[14px] hover:underline"
                    >
                      {bot ? `${bot.name}'s workspace` : entry.name}
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
                    {!undeletablePath(entry.path, botSlugs) && (
                      <DeleteEntry
                        entry={entry}
                        label={bot ? `${bot.name}'s workspace` : entry.name}
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
