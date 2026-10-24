import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A scrolling page with a consistent header. */
export function Page({
  title,
  description,
  actions,
  children,
  width = "default",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  width?: "default" | "wide" | "narrow";
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-8 px-5 py-8 sm:px-8 sm:py-10",
          width === "default" && "max-w-[980px]",
          width === "wide" && "max-w-[1280px]",
          width === "narrow" && "max-w-[720px]",
        )}
      >
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[26px] leading-tight font-semibold">{title}</h1>
            {description && (
              <p className="max-w-[60ch] text-[14.5px] text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}
