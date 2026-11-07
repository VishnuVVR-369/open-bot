import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A scrolling page with a consistent header. Every page shares one container, so one left edge;
 * the content, title row included, stops at 1120px, and the page's primary button sits at that
 * right edge. `wide` lets a board or grid reach further, with its button moving out with it.
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
  /** Page-level buttons, on the title's line, at the content's right edge. */
  actions?: ReactNode;
  children: ReactNode;
  width?: "default" | "wide";
}) {
  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto w-full max-w-[1520px] px-5 py-8 sm:px-10 sm:py-12">
        <div className={cn("flex w-full flex-col gap-8", width === "default" && "max-w-[1120px]")}>
          <header className="flex flex-col gap-1.5">
            <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-3">
              <h1 className="text-[28px] leading-tight font-semibold">{title}</h1>
              {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
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
