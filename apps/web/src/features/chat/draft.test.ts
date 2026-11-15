import type { Attachment, MessageView, SendMessageInput } from "@open-bot/api";
import { describe, expect, it, vi } from "vitest";
import type { Result } from "@/lib/client/mutate";
import { Draft } from "./draft";

const CHAT = "chat-1";
const LOST = "Couldn't reach open-bot. Check your connection and try again.";

/** An answer the test gives when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function attachmentFor(file: File): Attachment {
  return {
    name: file.name,
    path: `/home/bot/shared/uploads/${file.name}`,
    mime: file.type,
    size: file.size,
  };
}

/** A draft whose uploads and sends answer only when the test says so. */
function setup(kept = new Map<string, string>()) {
  const uploads = new Map<string, ReturnType<typeof deferred<Result<Attachment>>>>();
  const sends: {
    input: SendMessageInput;
    answer: ReturnType<typeof deferred<Result<MessageView>>>;
  }[] = [];
  let ids = 0;
  const onAttachError = vi.fn();
  const draft = new Draft({
    upload: (file) => {
      const answer = deferred<Result<Attachment>>();
      uploads.set(file.name, answer);
      return answer.promise;
    },
    send: (input) => {
      const answer = deferred<Result<MessageView>>();
      sends.push({ input, answer });
      return answer.promise;
    },
    newId: () => `id-${(ids += 1)}`,
    onAttachError,
    saved: {
      get: (chatId) => kept.get(chatId) ?? "",
      set: (chatId, text) => void (text ? kept.set(chatId, text) : kept.delete(chatId)),
    },
  });
  /** Attach files and let their uploads finish. */
  const attach = async (...names: string[]) => {
    const files = names.map(
      (name) => new File([`contents of ${name}`], name, { type: "text/plain" }),
    );
    draft.addFiles(files);
    for (const file of files)
      uploads.get(file.name)!.resolve({ ok: true, data: attachmentFor(file) });
    await vi.waitFor(() => expect(draft.ready).toBe(true));
    return files.map(attachmentFor);
  };
  /** Send, answer it, and return what was sent with the result. */
  const send = async (answer: Result<MessageView>) => {
    const sending = draft.send(CHAT, () => []);
    const sent = sends.at(-1)!;
    sent.answer.resolve(answer);
    return { input: sent.input, result: await sending };
  };
  return { draft, uploads, sends, attach, send, onAttachError, kept };
}

const saved = (input: SendMessageInput) =>
  ({ ok: true, data: { id: input.clientId } as unknown as MessageView }) as const;

describe("Draft", () => {
  it("puts the text and files back after a failed send, and sends them again under the same id", async () => {
    const { draft, sends, attach, send } = setup();
    const files = await attach("flight.txt", "hotel.txt");
    draft.setText("Here's my trip");
    const before = draft.snapshot();

    // The composer empties as soon as the message leaves.
    const sending = draft.send(CHAT, () => []);
    expect(draft.snapshot()).toEqual({ text: "", uploads: [] });
    sends[0]!.answer.resolve({ ok: false, error: LOST });
    expect(await sending).toEqual({ ok: false, error: LOST });
    expect(sends[0]!.input).toEqual({
      clientId: expect.any(String),
      chatId: CHAT,
      text: "Here's my trip",
      attachments: files,
      mentions: [],
    });

    // Both come back, as they were.
    expect(draft.snapshot()).toEqual(before);
    expect(draft.ready).toBe(true);

    // Sending again is the same message: the worker returns the one it saved, if it did.
    const again = await send({ ok: false, error: LOST });
    expect(again.input).toEqual(sends[0]!.input);
    const last = await send(saved(sends[0]!.input));
    expect(last.input.clientId).toBe(sends[0]!.input.clientId);
    expect(last.result.ok).toBe(true);
    expect(draft.snapshot()).toEqual({ text: "", uploads: [] });

    // After a success, the same words again are a new message.
    draft.setText("Here's my trip");
    const next = await send(saved(sends[0]!.input));
    expect(next.input.clientId).not.toBe(sends[0]!.input.clientId);
  });

  it("gives a changed message a new id", async () => {
    const { draft, attach, send } = setup();
    await attach("flight.txt", "hotel.txt");
    draft.setText("Here's my trip");
    const failed = await send({ ok: false, error: LOST });

    // Edited text.
    draft.setText("Here's my whole trip");
    const edited = await send({ ok: false, error: LOST });
    expect(edited.input.clientId).not.toBe(failed.input.clientId);

    // A file removed.
    draft.remove(draft.snapshot().uploads[1]!.id);
    const fewer = await send({ ok: false, error: LOST });
    expect(fewer.input.attachments).toHaveLength(1);
    expect(fewer.input.clientId).not.toBe(edited.input.clientId);

    // Unchanged since the last failure: that send's id again.
    const same = await send({ ok: false, error: LOST });
    expect(same.input.clientId).toBe(fewer.input.clientId);
  });

  it("keeps a file added while a send was failing, after the ones that come back", async () => {
    const { draft, sends, uploads, attach } = setup();
    await attach("flight.txt");
    draft.setText("Here's my flight");
    const sending = draft.send(CHAT, () => []);
    draft.addFiles([new File(["x"], "late.txt", { type: "text/plain" })]);
    sends[0]!.answer.resolve({ ok: false, error: LOST });
    await sending;
    expect(draft.snapshot().uploads.map((upload) => upload.name)).toEqual([
      "flight.txt",
      "late.txt",
    ]);
    expect(draft.ready).toBe(false);
    uploads.get("late.txt")!.resolve({ ok: false, error: "The file didn't arrive in one piece." });
    await vi.waitFor(() => expect(draft.snapshot().uploads).toHaveLength(1));
  });

  it("reads mentions from the text it sends", async () => {
    const { draft, sends } = setup();
    draft.setText("@Milo book it");
    const mentions = vi.fn(() => ["teammate-1"]);
    const sending = draft.send(CHAT, mentions);
    expect(mentions).toHaveBeenCalledWith("@Milo book it");
    expect(sends[0]!.input.mentions).toEqual(["teammate-1"]);
    sends[0]!.answer.resolve(saved(sends[0]!.input));
    await sending;
  });

  it("drops a file that can't be attached, and says why", async () => {
    const { draft, uploads, onAttachError } = setup();
    draft.addFiles([new File(["x"], "broken.txt", { type: "text/plain" })]);
    expect(draft.ready).toBe(false);
    uploads.get("broken.txt")!.resolve({ ok: false, error: "Sign in first." });
    await vi.waitFor(() => expect(draft.snapshot().uploads).toEqual([]));
    expect(onAttachError).toHaveBeenCalledWith("broken.txt", "Sign in first.");
  });

  it("keeps unsent text per chat, and never erases it before reading it", async () => {
    const { draft, kept, send } = setup();
    draft.open(CHAT);
    draft.setText("Half-written thought");
    expect(kept.get(CHAT)).toBe("Half-written thought");

    // A reload: a new, empty composer leaves the kept text alone until it opens the chat.
    const reloaded = setup(kept).draft;
    expect(reloaded.snapshot().text).toBe("");
    expect(kept.get(CHAT)).toBe("Half-written thought");
    reloaded.open(CHAT);
    reloaded.open(CHAT);
    expect(reloaded.snapshot().text).toBe("Half-written thought");

    // Another chat has its own.
    const other = setup(kept).draft;
    other.open("chat-2");
    expect(other.snapshot().text).toBe("");

    // A send that fails keeps the text; one that's saved lets it go.
    await send({ ok: false, error: LOST });
    expect(kept.get(CHAT)).toBe("Half-written thought");
    expect(draft.snapshot().text).toBe("Half-written thought");
    await send({ ok: true, data: { id: "saved" } as unknown as MessageView });
    expect(kept.has(CHAT)).toBe(false);
  });
});
