"use client";

import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkFileLinks } from "@/lib/remark-file-links";
import { cn } from "@/lib/utils";

const PLUGINS = [remarkGfm, remarkBreaks];
const PLUGINS_WITH_FILES = [...PLUGINS, remarkFileLinks];

/**
 * Markdown as chat shows it. Given `file`, a path to a file on the computer becomes what it
 * returns (chat's `Markdown` makes it a chip); without it, as in a file's own preview, links stay
 * links. Kept apart from the files feature so a file's preview can render Markdown.
 */
export const MarkdownText = memo(function MarkdownText({
  text,
  className,
  file,
}: {
  text: string;
  className?: string;
  file?: (path: string) => ReactNode;
}) {
  return (
    <div className={cn("prose-chat", className)}>
      <ReactMarkdown
        // A single line break is a line break, like in any chat.
        remarkPlugins={file ? PLUGINS_WITH_FILES : PLUGINS}
        components={{
          a: ({ href, children }) =>
            file && href?.startsWith("/home/bot/") ? (
              file(href)
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
