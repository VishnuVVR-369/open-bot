"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { allDocs, docs, sectionOf, sourceUrl } from "@/lib/docs";

/** The pathname without a trailing slash, so "/docs/" and "/docs" are the same page. */
function useDocPath(): string {
  const pathname = usePathname();
  return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
}

function NavLinks() {
  const current = useDocPath();
  return (
    <nav aria-label="Documentation" className="space-y-8">
      {docs.map((section) => (
        <div key={section.title}>
          <p className="mb-2 px-3 text-[0.75rem] font-semibold tracking-[0.08em] text-graphite uppercase">
            {section.title}
          </p>
          <ul className="space-y-px">
            {section.pages.map((page) => {
              const active = page.href === current;
              return (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-lg px-3 py-[0.3125rem] text-[0.9375rem] leading-snug transition-colors ${
                      active
                        ? "bg-sheet font-medium text-ink ring-1 ring-rule"
                        : "text-ink/70 hover:bg-ink/[0.04] hover:text-ink"
                    }`}
                  >
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The sidebar on wide screens. */
export function Sidebar() {
  return <NavLinks />;
}

/** The menu on narrow screens: a disclosure that closes when you pick a page. */
export function MobileNav() {
  const current = useDocPath();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [current]);
  const page = allDocs.find((entry) => entry.href === current);
  return (
    <details ref={ref} className="group border-b border-rule lg:hidden">
      <summary className="flex h-12 cursor-pointer list-none items-center justify-between px-5 text-[0.9375rem] font-medium sm:px-8 [&::-webkit-details-marker]:hidden">
        <span className="truncate">
          <span className="text-graphite">Menu</span>
          {page && <span className="text-ink"> / {page.title}</span>}
        </span>
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className="size-4 text-graphite transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="max-h-[70svh] overflow-y-auto px-2 pt-2 pb-8 sm:px-5">
        <NavLinks />
      </div>
    </details>
  );
}

/** The section name above a page's title. */
export function Eyebrow() {
  const section = sectionOf(useDocPath());
  if (!section) return null;
  return (
    <p className="mb-3 text-[0.8125rem] font-semibold tracking-[0.08em] text-graphite uppercase">
      {section.title}
    </p>
  );
}

/** Previous and next pages, and a link to the page's source. */
export function Pager() {
  const current = useDocPath();
  const index = allDocs.findIndex((page) => page.href === current);
  if (index === -1) return null;
  const previous = allDocs[index - 1];
  const next = allDocs[index + 1];
  return (
    <footer className="mt-20 border-t border-rule pt-8">
      <div className="grid gap-3 sm:grid-cols-2">
        {previous ? (
          <Link
            href={previous.href}
            className="group rounded-xl bg-sheet px-5 py-4 ring-1 ring-rule transition-shadow hover:ring-ink/30"
          >
            <span className="block text-sm text-graphite">Previous</span>
            <span className="mt-0.5 block font-medium">{previous.title}</span>
          </Link>
        ) : (
          <span className="hidden sm:block" />
        )}
        {next && (
          <Link
            href={next.href}
            className="group rounded-xl bg-sheet px-5 py-4 text-right ring-1 ring-rule transition-shadow hover:ring-ink/30"
          >
            <span className="block text-sm text-graphite">Next</span>
            <span className="mt-0.5 block font-medium">{next.title}</span>
          </Link>
        )}
      </div>
      <p className="mt-8 text-sm text-graphite">
        <a
          href={sourceUrl(current)}
          className="underline decoration-rule decoration-2 underline-offset-4 hover:text-ink hover:decoration-ink"
        >
          Edit this page on GitHub
        </a>
      </p>
    </footer>
  );
}
