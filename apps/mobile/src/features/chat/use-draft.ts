import { useCallback, useEffect, useRef, useState } from "react";
import {
  afterSend,
  appendKept,
  EMPTY_DRAFT,
  onKeptReply,
  readDraft,
  writeDraft,
  type Draft,
  type Kept,
} from "@/features/chat/drafts";

/**
 * The composer's draft: what you typed and whom it's for, saved as you type. It shows the chat's
 * saved draft when it opens, takes in a reply a notification kept while it's open (after what you
 * typed), and once a send goes through keeps only the replies kept while it was on its way.
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
  /**
   * The send on its way, as the replies kept since it was submitted: they're all that's left once
   * it goes through. What's typed meanwhile goes with it, as it always has.
   */
  const flight = useRef<Kept[] | null>(null);
  const kept = useRef(onKept);
  kept.current = onKept;

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
    const off = onKeptReply(chatId, (reply, after) => {
      flight.current?.push(reply);
      // Before the saved draft is shown, the store's draft (with the reply) is the whole of it.
      update(
        current.current.text ? appendKept(current.current, reply.text, reply.teammateId) : after,
      );
      kept.current?.(reply.text);
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
      flight.current = [];
      return current.current;
    }, []),
    /** The send is over: once it went through, only the replies kept meanwhile are left. */
    settle: useCallback(
      (sent: boolean) => {
        const keptSince = flight.current;
        flight.current = null;
        if (sent && keptSince) update(afterSend(keptSince));
      },
      [update],
    ),
  };
}
