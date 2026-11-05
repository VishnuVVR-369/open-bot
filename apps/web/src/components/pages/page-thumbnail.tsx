"use client";

import { FileText } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** The top of a page version as a picture, or a plain tile when there isn't one (or it's gone). */
export function PageThumbnail({ versionId, className }: { versionId: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const { resolvedTheme } = useTheme();
  // The theme is only known in the browser, so the picture waits for it rather than loading twice.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div
      className={cn(
        "relative aspect-[16/10] overflow-hidden bg-subtle",
        "after:pointer-events-none after:absolute after:inset-0 after:shadow-[inset_0_0_0_1px_var(--color-border)] after:content-['']",
        className,
      )}
    >
      {failed ? (
        <div className="flex size-full items-center justify-center text-muted-foreground/70">
          <FileText className="size-6" strokeWidth={1.6} />
        </div>
      ) : !mounted ? null : (
        <img
          src={`/api/pages/versions/${versionId}/thumbnail${resolvedTheme === "dark" ? "?theme=dark" : ""}`}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-cover object-top"
        />
      )}
    </div>
  );
}
