"use client";

import { cantAttach } from "@open-bot/api";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { describeFile, uploadAttachment } from "./uploads";
import type { MessageView } from "@/lib/types";

type Attachment = MessageView["attachments"][number];

/** A file being attached to the next message: uploading, or done with what the message sends. */
export interface Upload {
  id: string;
  name: string;
  status: "uploading" | "done";
  attachment?: Attachment;
}

/** The files attached to the message you're writing. Each starts uploading as you add it. */
export function useUploads() {
  const [uploads, setUploads] = useState<Upload[]>([]);

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const { name } = describeFile(file);
      const refused = cantAttach(file);
      if (refused) {
        toast.error(`Couldn't attach ${name}`, { description: refused });
        continue;
      }
      const id = crypto.randomUUID();
      setUploads((current) => [...current, { id, name, status: "uploading" }]);
      void uploadAttachment(file).then((result) => {
        if (!result.ok) {
          toast.error(`Couldn't attach ${name}`, { description: result.error });
          setUploads((current) => current.filter((upload) => upload.id !== id));
          return;
        }
        setUploads((current) =>
          current.map((upload) =>
            upload.id === id ? { ...upload, status: "done", attachment: result.data } : upload,
          ),
        );
      });
    }
  }, []);

  return {
    uploads,
    addFiles,
    /** Every file has finished uploading. */
    ready: uploads.every((upload) => upload.status === "done"),
    remove: (id: string) => setUploads((current) => current.filter((u) => u.id !== id)),
    clear: () => setUploads([]),
  };
}
