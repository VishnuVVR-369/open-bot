import {
  cantAttach,
  type Attachment,
  type MessageView,
  type SendMessageInput,
} from "@open-bot/api";
import { sendAttempt, type SendAttempt } from "@open-bot/chat-core";
import type { Result } from "@/lib/client/mutate";
import { describeFile } from "./uploads";

/** A file being attached to the next message: uploading, or done with what the message sends. */
export interface Upload {
  id: string;
  name: string;
  status: "uploading" | "done";
  attachment?: Attachment;
}

/** What the composer holds: the text you're writing and the files attached to it. */
export interface DraftState {
  text: string;
  uploads: Upload[];
}

export interface DraftDeps {
  /** Upload one file, answering with what a message sends for it. */
  upload: (file: File) => Promise<Result<Attachment>>;
  send: (input: SendMessageInput) => Promise<Result<MessageView>>;
  newId: () => string;
  /** A file that can't be attached, and why. */
  onAttachError: (name: string, error: string) => void;
  /** Each chat's unsent text, kept in this browser. */
  saved: {
    get: (chatId: string) => string;
    /** Empty text means there's nothing to keep. */
    set: (chatId: string, text: string) => void;
  };
}

/**
 * The message you're writing in a chat, outside React so its sending rules can be tested.
 * Its text is kept per chat until it's sent. Files start uploading as they're added. Sending empties the composer; a send that fails puts its
 * text and files back, and sending that same message again reuses the failed send's id, so the
 * worker saves it once even if the failure was a lost answer. Anything else gets a new id.
 */
export class Draft {
  private state: DraftState = { text: "", uploads: [] };
  /** The send that failed, which sending the same message again reuses. */
  private failed: SendAttempt | null = null;
  /** The chat whose text this is; nothing is kept before one is open. */
  private chatId: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: DraftDeps) {}

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** What the composer shows now; a new object after every change. */
  snapshot = (): DraftState => this.state;

  /** Every file has finished uploading. */
  get ready(): boolean {
    return this.state.uploads.every((upload) => upload.status === "done");
  }

  /**
   * Show a chat's kept text. Changes are kept from then on, so the empty composer a page starts
   * with never overwrites the text it hasn't read yet.
   */
  open = (chatId: string) => {
    if (chatId === this.chatId) return;
    this.chatId = chatId;
    this.update({ text: this.deps.saved.get(chatId) });
  };

  setText = (text: string) => {
    if (text !== this.state.text) this.update({ text });
  };

  addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const { name } = describeFile(file);
      const refused = cantAttach(file);
      if (refused) {
        this.deps.onAttachError(name, refused);
        continue;
      }
      const id = this.deps.newId();
      this.update({ uploads: [...this.state.uploads, { id, name, status: "uploading" }] });
      void this.deps.upload(file).then((result) => {
        if (!result.ok) {
          this.deps.onAttachError(name, result.error);
          this.remove(id);
          return;
        }
        this.update({
          uploads: this.state.uploads.map((upload) =>
            upload.id === id ? { ...upload, status: "done", attachment: result.data } : upload,
          ),
        });
      });
    }
  };

  remove = (id: string) => {
    this.update({ uploads: this.state.uploads.filter((upload) => upload.id !== id) });
  };

  /**
   * Send what's written and attached. The composer is emptied right away; if the send fails, its
   * text and files come back. `mentions` reads the teammates the text @-mentions.
   */
  send = async (
    chatId: string,
    mentions: (text: string) => string[],
  ): Promise<Result<MessageView>> => {
    const sent = this.state;
    const attachments = sent.uploads.flatMap((upload) =>
      upload.attachment ? [upload.attachment] : [],
    );
    const mentioned = mentions(sent.text);
    const thisSend = sendAttempt(
      this.failed,
      [chatId, sent.text, attachments, mentioned],
      this.deps.newId,
    );
    this.update({ text: "", uploads: [] });
    const result = await this.deps.send({
      clientId: thisSend.clientId,
      chatId,
      text: sent.text,
      attachments,
      mentions: mentioned,
    });
    if (result.ok) {
      this.failed = null;
      return result;
    }
    this.failed = thisSend;
    this.restore(sent);
    return result;
  };

  /** Put back a failed send's text and files, ahead of any files added since. */
  private restore(sent: DraftState) {
    this.update({
      text: sent.text,
      uploads: [
        ...sent.uploads,
        ...this.state.uploads.filter((upload) => !sent.uploads.some(({ id }) => id === upload.id)),
      ],
    });
  }

  private update(change: Partial<DraftState>) {
    const before = this.state.text;
    this.state = { ...this.state, ...change };
    if (this.chatId && this.state.text !== before)
      this.deps.saved.set(this.chatId, this.state.text);
    for (const listener of this.listeners) listener();
  }
}
