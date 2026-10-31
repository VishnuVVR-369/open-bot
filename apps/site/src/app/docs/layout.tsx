import Link from "next/link";
import { GitHubMark, Logo } from "@/components/icons";
import { Eyebrow, MobileNav, Pager, Sidebar } from "@/components/docs/nav";
import { TableOfContents } from "@/components/docs/toc";
import { site } from "@/lib/site";
import "./docs.css";

export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-rule bg-paper/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-2.5 rounded-lg"
              aria-label="open-bot home"
            >
              <Logo className="size-7" />
              <span className="font-display text-lg font-semibold tracking-[-0.02em]">
                open-bot
              </span>
            </Link>
            <span aria-hidden className="h-5 w-px bg-rule" />
            <Link href="/docs" className="rounded-md font-medium text-ink/75 hover:text-ink">
              Docs
            </Link>
          </div>
          <nav aria-label="Site" className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/"
              className="hidden rounded-full px-3 py-2 font-medium text-ink/75 hover:text-ink sm:block"
            >
              Tour
            </Link>
            <a
              href={site.github}
              className="ml-1 inline-flex h-9 items-center gap-2 rounded-full bg-ink px-3.5 text-[0.9375rem] font-medium text-white transition-colors hover:bg-ink/85"
            >
              <GitHubMark className="size-4" />
              GitHub
            </a>
          </nav>
        </div>
        <MobileNav />
      </header>

      <div className="mx-auto grid max-w-[1440px] gap-x-12 px-5 sm:px-8 lg:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_212px]">
        <aside className="hidden lg:block">
          <div className="sticky top-16 -ml-3 h-[calc(100svh-4rem)] overflow-y-auto pt-10 pb-16">
            <Sidebar />
          </div>
        </aside>

        <main className="min-w-0 pt-10 pb-24 sm:pt-14">
          <div className="mx-auto max-w-[792px]">
            <Eyebrow />
            <article className="doc">{children}</article>
            <Pager />
          </div>
        </main>

        <aside className="hidden xl:block">
          <div className="sticky top-16 max-h-[calc(100svh-4rem)] overflow-y-auto pt-14 pb-16">
            <TableOfContents />
          </div>
        </aside>
      </div>
    </>
  );
}
