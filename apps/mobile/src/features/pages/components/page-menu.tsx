import type { PageDetail } from "@open-bot/api";
import { ExternalLink, History, MessageSquareText, Pin, PinOff, Trash2 } from "lucide-react-native";
import { confirmDeletePage, setPagePinned } from "@/features/pages/components/page-row";
import { Sheet, SheetItem } from "@/components/sheet";
import { useColors } from "@/theme";

/**
 * A page's options. Each closes the menu first. `onChat` is null when the page has no chat to go
 * to, and `onDeleted` runs once the page is deleted.
 */
export function PageMenu({
  open,
  onClose,
  page,
  onVersions,
  onOpenInBrowser,
  onChat,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  page: PageDetail;
  onVersions: () => void;
  onOpenInBrowser: () => void;
  onChat: (() => void) | null;
  onDeleted: () => void;
}) {
  const colors = useColors();
  const choose = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <Sheet open={open} onClose={onClose} title={page.title} testID="page-options">
      {page.versions.length > 1 && (
        <SheetItem
          icon={<History size={20} color={colors.foreground} />}
          label="Versions"
          onPress={choose(onVersions)}
        />
      )}
      <SheetItem
        icon={<ExternalLink size={20} color={colors.foreground} />}
        label="Open in the browser"
        onPress={choose(onOpenInBrowser)}
        testID="page-open-browser"
      />
      {onChat && (
        <SheetItem
          icon={<MessageSquareText size={20} color={colors.foreground} />}
          label="Go to the chat"
          onPress={choose(onChat)}
        />
      )}
      <SheetItem
        icon={
          page.pinned ? (
            <PinOff size={20} color={colors.foreground} />
          ) : (
            <Pin size={20} color={colors.foreground} />
          )
        }
        label={page.pinned ? "Unpin" : "Pin to top"}
        onPress={choose(() => void setPagePinned(page, !page.pinned))}
      />
      <SheetItem
        icon={<Trash2 size={20} color={colors.destructive} />}
        label="Delete"
        destructive
        onPress={choose(() => confirmDeletePage(page, onDeleted))}
        testID="page-delete"
      />
    </Sheet>
  );
}
