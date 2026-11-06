import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A scrolling page with a consistent header. Every page shares one container and one left edge;
 * `width` only caps how far the content reaches to the right, for pages that read as a column.
 */
export function Page({
  title,
  description,
  actions,
  children,
  width = "default",
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Page-level buttons, on the title's line. */
  actions?: ReactNode;
  children: ReactNode;
  width?: "default" | "wide" | "narrow";
}) {
  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto w-full max-w-[1200px] px-5 py-8 sm:px-10 sm:py-12">
        <div
          className={cn(
            "flex w-full flex-col gap-8",
            width === "default" && "max-w-[920px]",
            width === "narrow" && "max-w-[720px]",
          )}
        >
          <header className="flex flex-col gap-1.5">
            <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-3">
              <h1 className="text-[28px] leading-tight font-semibold">{title}</h1>
              {actions && <div className="flex items-center gap-2">{actions}</div>}
            </div>
            {description && (
              <p className="max-w-[64ch] text-[14.5px] text-muted-foreground">{description}</p>
            )}
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}
