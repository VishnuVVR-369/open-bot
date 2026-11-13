"use client";

import { Hand, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Wordmark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useComputer } from "@/features/computer";
import { useAppState } from "@/lib/client/queries";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CommandMenuProvider } from "./command-menu";
import { NotificationsButton } from "./notifications";
import { Sidebar } from "./sidebar";

/**
 * Opens the menu on screens too narrow for the sidebar. A page with its own toolbar, like a chat,
 * puts the menu button there, so a phone shows one bar instead of two.
 */
const MobileMenuContext = createContext<(() => void) | null>(null);

export function useOpenMobileMenu() {
  return useContext(MobileMenuContext);
}

/** Pages whose own toolbar carries the menu button on a phone. */
function hasOwnToolbar(pathname: string) {
  return pathname.startsWith("/chats/");
}

/** A thin amber bar across the app while you hold a screen, so you never forget a bot is paused. */
function ControlBanner({ initial }: { initial: AppState }) {
  const { controlled, screen } = useComputer(initial);
  const pathname = usePathname();
  if (controlled.length === 0 || pathname === "/computer") return null;
  const names = controlled.map((id) => screen(id)?.bot.name).filter(Boolean) as string[];
  const text =
    names.length === 1
      ? `You have control of ${names[0]}'s screen. ${names[0]} won't use it until you hand it back.`
      : `You have control of ${names.length} screens. Those teammates won't use them until you hand them back.`;
  return (
    <div className="flex min-h-9 shrink-0 items-center justify-center gap-2 bg-attention px-4 py-1.5 text-center text-[13px] font-medium text-black">
      <Hand className="size-4 shrink-0" />
      <span>
        {text}
        <Link
          href={`/computer?screen=${controlled[0]}`}
          className="ml-2 underline underline-offset-2"
        >
          Open {names.length === 1 ? "it" : "the computer"}
        </Link>
      </span>
    </div>
  );
}

export function Shell({ initial, children }: { initial: AppState; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  const { data } = useAppState(initial);
  const unread = (data ?? initial).unreadNotifications;
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <CommandMenuProvider>
      <MobileMenuContext.Provider value={() => setMenuOpen(true)}>
        <div className="flex h-full flex-col">
          <ControlBanner initial={initial} />
          <div className="flex min-h-0 flex-1">
            <aside className="hidden w-[256px] shrink-0 lg:block">
              <Sidebar initial={initial} />
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <header
                className={cn(
                  "flex h-13 shrink-0 items-center gap-1.5 border-b border-sidebar-border bg-sidebar px-2.5 lg:hidden",
                  hasOwnToolbar(pathname) && "hidden",
                )}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Open menu"
                  onClick={() => setMenuOpen(true)}
                >
                  <Menu />
                </Button>
                <Link href="/">
                  <Wordmark />
                </Link>
                <span className="flex-1" />
                {/* The bell is on every screen, as it is at the top of the sidebar. */}
                <NotificationsButton count={unread} />
              </header>
              {/* On wide screens the page is a sheet of paper resting on the desk. */}
              <main className="min-h-0 flex-1 overflow-hidden bg-surface lg:my-2 lg:mr-2 lg:rounded-[14px] lg:shadow-canvas">
                {children}
              </main>
            </div>
          </div>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetContent
              side="left"
              className="p-0 data-[side=left]:w-[min(312px,85vw)]"
              showCloseButton={false}
            >
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <Sidebar
                initial={initial}
                onNavigate={() => setMenuOpen(false)}
                onClose={() => setMenuOpen(false)}
              />
            </SheetContent>
          </Sheet>
        </div>
      </MobileMenuContext.Provider>
    </CommandMenuProvider>
  );
}
