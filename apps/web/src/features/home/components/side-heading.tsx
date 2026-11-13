"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

export function SideHeading({
  title,
  href,
  label,
}: {
  title: string;
  href: string;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        {title}
      </h2>
      <Link
        href={href}
        className="flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {label}
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}
