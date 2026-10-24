"use client";

import {
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { FilePreview } from "@/components/files/file-preview";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fileKind, type FileKind } from "@/lib/files";
import { cn } from "@/lib/utils";

const ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  markdown: FileText,
  csv: FileSpreadsheet,
  text: FileCode,
  other: File,
};

export function FileIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[fileKind(name)];
  return <Icon className={className} />;
}

/** A file on the computer, mentioned in a reply. Opens a preview. */
export function FileChip({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const name = path.split("/").pop() ?? path;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              "inline-flex max-w-full translate-y-[-1px] items-center gap-1 rounded-md border bg-card px-1.5 align-middle text-[0.9em] leading-[1.6] font-medium shadow-xs transition-colors",
              "hover:border-foreground/20 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            )}
            data-testid="file-chip"
          >
            <FileIcon name={name} className="size-[1.05em] shrink-0 text-muted-foreground" />
            <span className="truncate">{name}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="font-mono text-[12px]">{path}</TooltipContent>
      </Tooltip>
      <FilePreview path={path} open={open} onOpenChange={setOpen} />
    </>
  );
}
