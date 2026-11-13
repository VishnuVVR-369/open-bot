"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * The timeline's scrolling: it sticks to the bottom while new content streams in, unless you
 * scrolled up to read, and a link to one run (`#run-<id>`) opens the chat at that run. Put
 * `scroller` and `onScroll` on the scrolling element.
 */
export function useChatScroll(loading: boolean, entries: readonly unknown[]) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Scrolled away from the top: the header gets a hairline so content doesn't slide under it unmarked.
  const [scrolled, setScrolled] = useState(false);

  // Stick to the bottom while new content streams in, unless you scrolled up to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom) element.scrollTop = element.scrollHeight;
  });

  // A link to one run, like from a schedule's history, opens the chat at that run.
  const jumpedTo = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (loading) return;
    const hash = window.location.hash.slice(1);
    if (!hash.startsWith("run-") || jumpedTo.current === hash) return;
    const target = document.getElementById(hash);
    if (!target) return;
    jumpedTo.current = hash;
    target.scrollIntoView({ block: "start" });
    onScroll();
    target.classList.add("run-highlight");
    setTimeout(() => target.classList.remove("run-highlight"), 2500);
  }, [loading, entries]);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
    setScrolled(element.scrollTop > 4);
  }

  return {
    scroller,
    onScroll,
    atBottom,
    scrolled,
    /** Follow new content again, as after you send a message. */
    stickToBottom: () => setAtBottom(true),
    scrollToLatest: () =>
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }),
  };
}
