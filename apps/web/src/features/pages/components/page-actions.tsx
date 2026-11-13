"use client";

import type { PageTheme } from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { attempt } from "@/lib/client/mutate";
import { refreshForAppEvent } from "@/lib/client/refresh";
import { api, orpc } from "@/lib/client/rpc";

/** Pin or unpin, then refresh the lists that show it. */
export function usePinPage() {
  const queryClient = useQueryClient();
  return async (pageId: string, pinned: boolean) => {
    const result = await attempt(api.pages.pin({ pageId, pinned }));
    if (!result.ok) toast.error(result.error);
    await refreshForAppEvent(queryClient, { type: "pages" });
  };
}

/**
 * Open a version in a tab of its own. The tab opens right away (so it isn't blocked as a popup)
 * and goes to the page once its link is ready.
 */
export async function openPageInTab(versionId: string, theme: PageTheme) {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  try {
    const link = await api.pages.open({ versionId, theme });
    if (tab) tab.location.href = link.url;
    else window.location.href = link.url;
  } catch (error) {
    tab?.close();
    toast.error("Couldn't open the page", {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

export function downloadPage(versionId: string) {
  const link = document.createElement("a");
  link.href = `/api/pages/versions/${versionId}/download`;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function DeletePageDialog({
  page,
  open,
  onOpenChange,
  onDeleted,
}: {
  page: { id: string; title: string; versionCount: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{page.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {page.versionCount === 1
              ? "The page is deleted everywhere, including the chat it was made in."
              : `All ${page.versionCount} versions are deleted everywhere, including the chat it was made in.`}{" "}
            The file it was made from stays on the computer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              const result = await attempt(api.pages.remove({ pageId: page.id }));
              if (!result.ok) {
                toast.error(result.error);
                return;
              }
              onDeleted?.();
              queryClient.removeQueries({
                queryKey: orpc.pages.get.key({ input: { pageId: page.id } }),
              });
              await refreshForAppEvent(queryClient, { type: "pages" });
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
