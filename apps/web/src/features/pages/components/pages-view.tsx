"use client";

import {
  Download,
  ExternalLink,
  FileText,
  MoreHorizontal,
  Pin,
  PinOff,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useMemo, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppState } from "@/features/app-shell";
import { usePages } from "../hooks";
import type { BotSummary, PageSummary } from "@/lib/types";
import { DeletePageDialog, downloadPage, openPageInTab, usePinPage } from "./page-actions";
import { pageHref } from "./page-card";
import { PageThumbnail } from "./page-thumbnail";

function PageTile({ page, bot }: { page: PageSummary; bot: BotSummary | undefined }) {
  const pin = usePinPage();
  const { resolvedTheme } = useTheme();
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <li
      className="group/tile relative flex flex-col overflow-hidden rounded-xl bg-card shadow-raised transition-shadow hover:shadow-float has-focus-visible:ring-2 has-focus-visible:ring-ring/50"
      data-testid="page-tile"
    >
      <Link
        href={pageHref(page.id)}
        className="flex flex-1 flex-col outline-none"
        aria-label={page.title}
      >
        <PageThumbnail versionId={page.versionId} className="border-b after:shadow-none" />
        <div className="flex flex-1 flex-col gap-1 px-4 pt-3 pb-3.5">
          <span className="line-clamp-2 pr-6 font-heading text-[15px] leading-snug font-semibold">
            {page.title}
          </span>
          {page.summary && (
            <p className="line-clamp-2 text-[13px] leading-normal text-muted-foreground">
              {page.summary}
            </p>
          )}
          <div className="mt-auto flex items-center gap-1.5 pt-2 text-[12.5px] text-muted-foreground">
            <BotAvatar
              name={bot?.name ?? "Former teammate"}
              color={bot?.color ?? "#888888"}
              emoji={bot?.emoji}
              size="xs"
            />
            <span className="truncate">{bot?.name ?? "Former teammate"}</span>
            <span aria-hidden>·</span>
            <TimeAgo date={page.updatedAt} className="shrink-0" />
            {page.versionCount > 1 && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0">v{page.version}</span>
              </>
            )}
          </div>
        </div>
      </Link>
      {page.pinned && (
        <span
          className="absolute top-2.5 left-2.5 flex size-6 items-center justify-center rounded-md bg-background/90 text-foreground shadow-xs backdrop-blur"
          aria-label="Pinned"
          title="Pinned"
        >
          <Pin className="size-3.5" />
        </span>
      )}
      <div
        className="absolute top-2.5 right-2.5 opacity-100 transition-opacity data-[open=true]:opacity-100 sm:opacity-0 sm:group-focus-within/tile:opacity-100 sm:group-hover/tile:opacity-100"
        data-open={menuOpen}
      >
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              className="bg-background/90 shadow-xs backdrop-blur"
              aria-label={`Options for ${page.title}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => void pin(page.id, !page.pinned)}>
              {page.pinned ? <PinOff /> : <Pin />}
              {page.pinned ? "Unpin" : "Pin to top"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void openPageInTab(page.versionId, resolvedTheme === "dark" ? "dark" : "light")
              }
            >
              <ExternalLink />
              Open in a new tab
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => downloadPage(page.versionId)}>
              <Download />
              Download
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DeletePageDialog page={page} open={deleting} onOpenChange={setDeleting} />
    </li>
  );
}

function matches(page: PageSummary, bot: BotSummary | undefined, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [page.title, page.summary, bot?.name ?? ""].some((value) =>
    value.toLowerCase().includes(q),
  );
}

/** Every page teammates have published, pinned ones first. */
export function PagesView() {
  const { data, isLoading } = usePages();
  const { data: state } = useAppState();
  const [query, setQuery] = useState("");
  const botOf = useMemo(() => {
    const bots = new Map((state?.bots ?? []).map((bot) => [bot.id, bot]));
    return (id: string | null) => (id ? bots.get(id) : undefined);
  }, [state?.bots]);
  const pages = data ?? [];
  const shown = pages.filter((page) => matches(page, botOf(page.botId), query));

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="aspect-[4/3.6] rounded-xl" />
        ))}
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-14 text-center">
        <FileText className="size-6 text-muted-foreground" />
        <p className="font-medium">No pages yet</p>
        <p className="max-w-md text-[13.5px] text-muted-foreground">
          Ask a teammate for one in any chat, like &ldquo;Read this post and make a page explaining
          the system design&rdquo; or &ldquo;Compare these three laptops as a page&rdquo;. Pages
          open here, on your phone, and in the chat where they were made.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {pages.length > 6 && (
        <InputGroup className="h-9 max-w-sm">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a page"
            aria-label="Find a page"
          />
        </InputGroup>
      )}
      {shown.length === 0 ? (
        <p className="py-10 text-center text-[13.5px] text-muted-foreground">
          No pages match &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((page) => (
            <PageTile key={page.id} page={page} bot={botOf(page.botId)} />
          ))}
        </ul>
      )}
    </div>
  );
}
