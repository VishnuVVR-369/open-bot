import type { Attachment } from "@open-bot/api";
import { cantAttach } from "@open-bot/api";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_ATTACHMENTS, pickedDocument, pickedPhoto, type AttachSource } from "./picked-files";
import type { PickedFile } from "./uploads";
import { uploadAttachment } from "./uploads";

/** A file being attached to the next message. */
export interface PendingFile {
  key: string;
  file: PickedFile;
  progress: number;
  state: "uploading" | "done" | "failed";
  attachment?: Attachment;
  error?: string;
  controller: AbortController;
}

/**
 * The files you're attaching in a chat: each uploads as soon as you pick it, and can be retried
 * or dropped. Leaving the chat drops what's still uploading. `onError` says what went wrong
 * picking files, or null once you try again.
 */
export function useAttachments(chatId: string, onError: (message: string | null) => void) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;

  // Unmounting the chat drops what's uploading too.
  useEffect(
    () => () => {
      for (const pending of filesRef.current) pending.controller.abort();
    },
    [chatId],
  );

  const update = (key: string, change: Partial<PendingFile>) =>
    setFiles((current) =>
      current.map((pending) => (pending.key === key ? { ...pending, ...change } : pending)),
    );

  const upload = useCallback((pending: PendingFile) => {
    void uploadAttachment(pending.file, {
      signal: pending.controller.signal,
      onProgress: (progress) => update(pending.key, { progress }),
    }).then((answer) => {
      if (pending.controller.signal.aborted) return;
      if (answer.kind === "complete")
        update(pending.key, { state: "done", attachment: answer.attachment, progress: 1 });
      else
        update(pending.key, {
          state: "failed",
          error: answer.kind === "signedOut" ? "Sign in again to attach files." : answer.message,
        });
    });
  }, []);

  function add(picked: PickedFile[]) {
    onError(null);
    const room = MAX_ATTACHMENTS - filesRef.current.length;
    if (picked.length > room) onError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
    const added: PendingFile[] = picked.slice(0, Math.max(0, room)).map((file) => {
      const problem = cantAttach(file);
      return {
        key: Crypto.randomUUID(),
        file,
        progress: 0,
        state: problem ? "failed" : "uploading",
        error: problem ?? undefined,
        controller: new AbortController(),
      };
    });
    setFiles((current) => [...current, ...added]);
    for (const pending of added) if (pending.state === "uploading") upload(pending);
  }

  function retry(pending: PendingFile) {
    if (cantAttach(pending.file)) return;
    const next: PendingFile = {
      ...pending,
      state: "uploading",
      progress: 0,
      error: undefined,
      controller: new AbortController(),
    };
    setFiles((current) => current.map((entry) => (entry.key === pending.key ? next : entry)));
    upload(next);
  }

  function remove(pending: PendingFile) {
    pending.controller.abort();
    setFiles((current) => current.filter((entry) => entry.key !== pending.key));
  }

  /** Drops the files a message carried, keeping any you picked while it was sending. */
  function clearSent(sent: PendingFile[]) {
    const keys = new Set(sent.map((pending) => pending.key));
    setFiles((current) => current.filter((pending) => !keys.has(pending.key)));
  }

  async function pick(source: AttachSource) {
    onError(null);
    if (source === "files") {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      add(result.assets.map(pickedDocument));
      return;
    }
    if (source === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        onError("Allow open-bot to use the camera in Android's settings.");
        return;
      }
    }
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ["images"],
      quality: 0.85,
      allowsMultipleSelection: source === "photos",
      selectionLimit: MAX_ATTACHMENTS,
    };
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled) return;
    const now = Date.now();
    add(result.assets.map((asset, index) => pickedPhoto(asset, { source, index, now })));
  }

  return {
    files,
    uploading: files.some((pending) => pending.state === "uploading"),
    failed: files.some((pending) => pending.state === "failed"),
    ready: files.filter((pending) => pending.state === "done"),
    pick,
    retry,
    remove,
    clearSent,
  };
}
