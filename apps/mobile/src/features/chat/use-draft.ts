import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendKept,
  beginSend,
  EMPTY_DRAFT,
  endSend,
  readDraft,
  watchDraft,
  writeDraft,
  type Draft,
  type PendingSend,
} from "@/features/chat/drafts";

/**
 * The composer's draft: what you typed and whom it's for, saved as you type. It shows the chat's
 * saved draft when it opens, takes in a reply a notification kept while it's open (after what you
 * typed), and once a send goes through keeps only the replies kept while it was on its way. The
 * draft store tracks that send, so it holds even if you leave the chat before it goes through.
 */
export function useDraft(
  chatId: string,
  {
    onKept,
  }: {
    /** A reply was kept while the chat is open, after what's in the box (so dictation can follow). */
    onKept?: (text: string) => void;
  } = {},
) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // Read by the listeners below between renders, so it changes with every update at once.
  const current = useRef(draft);
  const flight = useRef<PendingSend | null>(null);
  const kept = useRef(onKept);
  kept.current = onKept;

  const show = useCallback((next: Draft) => {
    current.current = next;
    setDraft(next);
  }, []);
  const update = useCallback(
    (next: Draft) => {
      show(next);
      writeDraft(chatId, next);
    },
    [chatId, show],
  );

  useEffect(() => {
    let live = true;
    // What you'd typed here before, unless you've started typing already.
    void readDraft(chatId).then((saved) => {
      if (live && saved.text && !current.current.text) show(saved);
    });
    const off = watchDraft(chatId, (event) => {
      // A send went through, from this composer or one that showed the chat before it.
      if (event.kind === "sent") return show(event.draft);
      const { text, teammateId } = event.kept;
      // Before the saved draft is shown, the store's draft (with the reply) is the whole of it.
      update(current.current.text ? appendKept(current.current, text, teammateId) : event.draft);
      kept.current?.(text);
    });
    return () => {
      live = false;
      off();
    };
  }, [chatId, show, update]);

  return {
    draft,
    /** The draft as it is right now, between renders too. */
    latest: useCallback(() => current.current, []),
    edit: useCallback((text: string) => update({ ...current.current, text }), [update]),
    address: useCallback(
      (mentions: string[]) => update({ ...current.current, mentions: [...new Set(mentions)] }),
      [update],
    ),
    /** The version being sent. */
    submit: useCallback(() => {
      flight.current = beginSend(chatId);
      return current.current;
    }, [chatId]),
    /** The send is over: once it went through, only the replies kept meanwhile are left. */
    settle: useCallback((sent: boolean) => {
      const send = flight.current;
      flight.current = null;
      if (send) endSend(send, sent);
    }, []),
  };
}
