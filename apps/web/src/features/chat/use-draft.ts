"use client";

import { useEffect, useState } from "react";

/** The message you're writing in a chat, kept in this browser until you send it. */
export function useDraft(chatId: string) {
  const [text, setText] = useState("");
  const draftKey = `open-bot:draft:${chatId}`;
  useEffect(() => {
    setText(localStorage.getItem(draftKey) ?? "");
  }, [draftKey]);
  useEffect(() => {
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  }, [text, draftKey]);
  return [text, setText] as const;
}
