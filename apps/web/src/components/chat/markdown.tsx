"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { FileChip } from "@/components/files/file-chip";
import { remarkFileLinks } from "@/lib/remark-file-links";
import { cn } from "@/lib/utils";

const PLUGINS = [remarkGfm, remarkBreaks];
// Files on the computer become chips that open a preview.
const PLUGINS_WITH_FILES = [...PLUGINS, remarkFileLinks];

export const Markdown = memo(function Markdown({
  text,
  className,
  files = true,
}: {
  text: string;
  className?: string;
  /** Show files on the computer as chips. Off inside a file's own preview. */
  files?: boolean;
}) {
  return (
    <div className={cn("prose-chat", className)}>
      <ReactMarkdown
        // A single line break is a line break, like in any chat.
        remarkPlugins={files ? PLUGINS_WITH_FILES : PLUGINS}
        components={{
          a: ({ href, children }) =>
            files && href?.startsWith("/home/bot/") ? (
              <FileChip path={href} />
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
