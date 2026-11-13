"use client";

import { type ReactNode } from "react";

export function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="flex scroll-mt-8 flex-col gap-4 border-t pt-8 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        {description && (
          <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}
