import { useCallback, useEffect, useRef, useState } from "react";
import {
  afterSend,
  appendKept,
  EMPTY_DRAFT,
  onKeptReply,
  readDraft,
  writeDraft,
  type Draft,
} from "@/features/chat/drafts";

/**
 * The composer's draft: what you typed and whom it's for, saved as you type. It shows the chat's
 * saved draft when it opens, takes in a reply a notification kept while it's open (after what you
 * typed), and once a send succeeds clears only the version that was sent.
 */
export function useDraft(chatId: string) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // Read by the listeners below between renders, so it changes with every update at once.
  const current = useRef(draft);
  /** The send in flight: the version it submitted, and whom replies kept meanwhile were for. */
  const flight = useRef<{ submitted: Draft; kept: string[] } | null>(null);

  const update = useCallback(
    (next: Draft) => {
      current.current = next;
      setDraft(next);
      writeDraft(chatId, next);
    },
    [chatId],
  );

  useEffect(() => {
    let live = true;
    // What you'd typed here before, unless you've started typing already.
    void readDraft(chatId).then((saved) => {
      if (!live || !saved.text || current.current.text) return;
      current.current = saved;
      setDraft(saved);
    });
    const off = onKeptReply(chatId, (kept, after) => {
      if (flight.current && kept.teammateId) flight.current.kept.push(kept.teammateId);
      // Before the saved draft is shown, the store's draft (with the reply) is the whole of it.
      update(
        current.current.text ? appendKept(current.current, kept.text, kept.teammateId) : after,
      );
    });
    return () => {
      live = false;
      off();
    };
  }, [chatId, update]);

  return {
    draft,
    edit: useCallback((text: string) => update({ ...current.current, text }), [update]),
    address: useCallback(
      (mentions: string[]) => update({ ...current.current, mentions: [...new Set(mentions)] }),
      [update],
    ),
    /** The version being sent. */
    submit: useCallback(() => {
      flight.current = { submitted: current.current, kept: [] };
      return current.current;
    }, []),
    /** The send is over: once it went through, what it sent is cleared, and nothing more. */
    settle: useCallback(
      (sent: boolean) => {
        const done = flight.current;
        flight.current = null;
        if (sent && done) update(afterSend(current.current, done.submitted, done.kept));
      },
      [update],
    ),
  };
}
