"use client";

import { memo } from "react";
import { MarkdownText } from "@/components/markdown-text";
import { FileChip } from "@/features/files";

// Files on the computer become chips that open a preview.
const fileChip = (path: string) => <FileChip path={path} />;

/** A message's Markdown, with files on the computer shown as chips. */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return <MarkdownText text={text} className={className} file={fileChip} />;
});
