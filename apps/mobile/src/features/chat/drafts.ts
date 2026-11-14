import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * What you'd typed in each chat but not sent, so leaving a chat (for an approval, the screen, or
 * another app) doesn't lose it. Kept on the phone; sending a message clears its draft.
 */
const KEY = "openbot:drafts";
/** The most drafts kept, newest first, so the store can't grow without end. */
const MAX = 50;

let drafts: Record<string, string> = {};
const loaded = AsyncStorage.getItem(KEY)
  .then((saved) => {
    if (saved) drafts = { ...(JSON.parse(saved) as Record<string, string>), ...drafts };
  })
  .catch(() => {});

let timer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void AsyncStorage.setItem(KEY, JSON.stringify(drafts)).catch(() => {});
  }, 400);
}

/** The chat's draft, once the saved drafts have been read. */
export async function readDraft(chatId: string): Promise<string> {
  await loaded;
  return drafts[chatId] ?? "";
}

export function writeDraft(chatId: string, text: string) {
  const { [chatId]: _previous, ...rest } = drafts;
  drafts = text.trim()
    ? Object.fromEntries([[chatId, text], ...Object.entries(rest)].slice(0, MAX))
    : rest;
  save();
}
