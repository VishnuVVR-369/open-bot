"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { FileIcon, FilePreview } from "@/features/files";
import { fileKind, fileUrl } from "@/lib/files";
import type { MessageView } from "@/lib/types";
import { CollapsibleText } from "./collapsible-text";
import { MessageText } from "./message-text";

/** A file you attached. Opens a preview when the app can show it, and downloads otherwise. */
function Attachment({ file }: { file: MessageView["attachments"][number] }) {
  const [open, setOpen] = useState(false);
  const className =
    "flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-muted";
  const content = (
    <>
      <FileIcon name={file.name} className="size-3.5 text-muted-foreground" />
      {file.name}
    </>
  );
  if (fileKind(file.name) === "other")
    return (
      <a href={fileUrl(file.path)} className={className}>
        {content}
      </a>
    );
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {content}
      </button>
      <FilePreview path={file.path} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function UserMessage({ message }: { message: MessageView }) {
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="user-message">
      {message.redoOfRunId && (
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <RotateCcw className="size-3" />
          Asked to try again
        </span>
      )}
      {message.attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {message.attachments.map((file) => (
            <Attachment key={file.path} file={file} />
          ))}
        </div>
      )}
      <div className="max-w-[85%] rounded-[18px] rounded-br-[6px] bg-[color-mix(in_oklab,var(--foreground)_6.5%,var(--surface))] px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap text-foreground">
        <CollapsibleText watch={message.text}>
          <MessageText text={message.text} />
        </CollapsibleText>
      </div>
    </div>
  );
}
