"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import { Draft } from "./draft";
import { uploadAttachment } from "./uploads";

const draftKey = (chatId: string) => `open-bot:draft:${chatId}`;

// Storage can be blocked (a private window, cleared site data); the draft then just isn't kept.
function savedText(chatId: string): string {
  try {
    return localStorage.getItem(draftKey(chatId)) ?? "";
  } catch {
    return "";
  }
}

function keepText(chatId: string, text: string) {
  try {
    if (text) localStorage.setItem(draftKey(chatId), text);
    else localStorage.removeItem(draftKey(chatId));
  } catch {
    // Not kept.
  }
}

/**
 * The message you're writing in a chat (`Draft`): its text, kept in this browser until you send
 * it, and its files.
 */
export function useDraft(chatId: string) {
  const [draft] = useState(
    () =>
      new Draft({
        upload: (file) => uploadAttachment(file),
        send: (input) => attempt(api.chats.send(input)),
        newId: () => crypto.randomUUID(),
        onAttachError: (name, error) =>
          toast.error(`Couldn't attach ${name}`, { description: error }),
        saved: { get: savedText, set: keepText },
      }),
  );
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  useEffect(() => {
    draft.open(chatId);
    return draft.close;
  }, [draft, chatId]);
  return { draft, ...state, ready: draft.ready };
}
