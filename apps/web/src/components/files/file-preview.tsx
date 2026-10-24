"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, FileText, FileWarning, Loader2, X } from "lucide-react";
import { useState } from "react";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { fileKind, fileUrl } from "@/lib/files";
import { cn } from "@/lib/utils";

/** The most text a preview shows; the download has the rest. */
const MAX_PREVIEW_CHARS = 400_000;
const MAX_CSV_ROWS = 300;

/** Rows of a CSV or TSV, handling quoted fields. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length <= MAX_CSV_ROWS; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

class MissingFile extends Error {}

function useFileText(path: string, enabled: boolean) {
  return useQuery({
    queryKey: ["file-text", path],
    enabled,
    // Teammates change files; opening one again shows what's there now.
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const response = await fetch(fileUrl(path, true));
      if (response.status === 404) throw new MissingFile();
      if (!response.ok) throw new Error(`The file didn't load (${response.status}).`);
      const text = await response.text();
      return {
        text: text.slice(0, MAX_PREVIEW_CHARS),
        truncated: text.length > MAX_PREVIEW_CHARS,
      };
    },
  });
}

function Body({ path, name }: { path: string; name: string }) {
  const kind = fileKind(name);
  const readsText = kind === "markdown" || kind === "csv" || kind === "text";
  const file = useFileText(path, readsText);
  const [imageFailed, setImageFailed] = useState(false);

  if (kind === "image")
    return imageFailed ? (
      <Missing />
    ) : (
      <div className="flex min-h-48 items-center justify-center bg-[repeating-conic-gradient(var(--subtle)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-4">
        <img
          src={fileUrl(path, true)}
          alt={name}
          className="max-h-[70vh] max-w-full rounded-md object-contain shadow-sm"
          onError={() => setImageFailed(true)}
        />
      </div>
    );
  if (kind === "pdf")
    return <iframe src={fileUrl(path, true)} title={name} className="h-[72vh] w-full bg-white" />;
  if (kind === "other")
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
        <FileText className="size-6 text-muted-foreground" />
        <p className="text-[14px] font-medium">No preview for this kind of file</p>
        <p className="text-[13px] text-muted-foreground">
          Download it to open it on your computer.
        </p>
      </div>
    );
  if (file.isLoading)
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Opening…
      </div>
    );
  if (file.error)
    return file.error instanceof MissingFile ? (
      <Missing />
    ) : (
      <p className="px-6 py-14 text-center text-[13px] text-muted-foreground">
        {file.error.message}
      </p>
    );
  const { text, truncated } = file.data!;
  return (
    <>
      {kind === "markdown" ? (
        <div className="px-6 py-5">
          <Markdown text={text} files={false} />
        </div>
      ) : kind === "csv" ? (
        <CsvTable text={text} delimiter={name.toLowerCase().endsWith(".tsv") ? "\t" : ","} />
      ) : (
        <pre className="px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words">
          {text}
        </pre>
      )}
      {truncated && (
        <p className="border-t px-5 py-2.5 text-[12.5px] text-muted-foreground">
          The preview shows the start of the file. Download it for the rest.
        </p>
      )}
    </>
  );
}

function CsvTable({ text, delimiter }: { text: string; delimiter: string }) {
  const rows = parseDelimited(text, delimiter);
  const [header, ...body] = rows.slice(0, MAX_CSV_ROWS);
  if (!header) return <p className="px-6 py-14 text-center text-[13px]">The file is empty.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-card">
          <tr>
            {header.map((cell, index) => (
              <th
                key={index}
                className="border-b px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="even:bg-muted/30">
              {header.map((_, index) => (
                <td key={index} className="border-b px-3 py-1.5 align-top whitespace-nowrap">
                  {row[index] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_CSV_ROWS && (
        <p className="px-3 py-2.5 text-[12.5px] text-muted-foreground">
          Showing the first {MAX_CSV_ROWS - 1} rows.
        </p>
      )}
    </div>
  );
}

function Missing() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <FileWarning className="size-6 text-muted-foreground" />
      <p className="text-[14px] font-medium">This file isn&apos;t there anymore</p>
      <p className="text-[13px] text-muted-foreground">
        It may have been moved or deleted on the computer.
      </p>
    </div>
  );
}

/** A file on the computer, shown in the app: images, PDFs, Markdown, tables and text. */
export function FilePreview({
  path,
  open,
  onOpenChange,
}: {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const name = path.split("/").pop() ?? path;
  const folder = path.slice(0, path.length - name.length - 1);
  const kind = fileKind(name);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl",
          kind === "pdf" && "sm:max-w-5xl",
        )}
        data-testid="file-preview"
        showCloseButton={false}
      >
        <div className="flex items-center gap-2 border-b py-3 pr-3 pl-5">
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="truncate text-[15px]">{name}</DialogTitle>
            <DialogDescription className="truncate font-mono text-[12px]">
              {folder}
            </DialogDescription>
          </div>
          {kind !== "other" && (
            <Button variant="ghost" size="icon-sm" asChild aria-label="Open in a new tab">
              <a href={fileUrl(path, true)} target="_blank" rel="noreferrer">
                <ExternalLink />
              </a>
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <a href={fileUrl(path)}>
              <Download />
              Download
            </a>
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close">
              <X />
            </Button>
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {open && <Body path={path} name={name} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
