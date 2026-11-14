import type { BotSummary, PageSummary } from "@open-bot/api";
import { safe } from "@orpc/client";
import { router } from "expo-router";
import { EllipsisVertical, Pin, PinOff, Trash2 } from "lucide-react-native";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { BotAvatar } from "@/features/teammates/components/bot-avatar";
import { PageThumb } from "@/features/pages/components/page-thumb";
import { Sheet, SheetItem } from "@/components/sheet";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { animateLayout } from "@/lib/motion";
import { pageHref } from "@/features/pages/pages";
import { queryClient, queryKeys } from "@/lib/query";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";

/**
 * A page in a list: its picture, title, summary, and who made it when, with a menu button (pin,
 * delete) at the end. Holding the row opens the same menu.
 */
export function PageRow({
  page,
  bot,
  first,
  onMenu,
}: {
  page: PageSummary;
  bot: BotSummary | undefined;
  first: boolean;
  onMenu?: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        router.push(pageHref(page.id));
      }}
      onLongPress={
        onMenu
          ? () => {
              haptics.press();
              onMenu();
            }
          : undefined
      }
      accessibilityRole="button"
      accessibilityLabel={page.title}
      android_ripple={{ color: colors.muted }}
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
      ]}
      testID="page-row"
    >
      <View style={[styles.thumb, { borderColor: colors.border }]}>
        <PageThumb versionId={page.versionId} style={styles.picture} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.titleRow}>
          {page.pinned && <Pin size={12} color={colors.mutedForeground} />}
          <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
            {page.title}
          </Text>
        </View>
        {page.summary ? (
          <Text variant="small" muted numberOfLines={2}>
            {page.summary}
          </Text>
        ) : null}
        <View style={styles.meta}>
          {bot && <BotAvatar {...bot} size="xs" />}
          <Text variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
            {[
              bot?.name ?? "Former teammate",
              ago(page.updatedAt),
              page.versionCount > 1 ? `v${page.version}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
      </View>
      {onMenu && (
        <Pressable
          onPress={() => {
            haptics.tap();
            onMenu();
          }}
          accessibilityRole="button"
          accessibilityLabel={`Options for ${page.title}`}
          android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
          style={styles.more}
          testID="page-more"
        >
          <EllipsisVertical size={20} color={colors.mutedForeground} />
        </Pressable>
      )}
    </Pressable>
  );
}

/** Pin or unpin a page, telling you if it didn't work. */
export async function setPagePinned(page: PageSummary, pinned: boolean) {
  const result = await safe(api.pages.pin({ pageId: page.id, pinned }));
  if (result.error) {
    Alert.alert(pinned ? "Couldn't pin it" : "Couldn't unpin it", errorMessage(result.error));
    return;
  }
  haptics.success();
  animateLayout();
  void queryClient.invalidateQueries({ queryKey: queryKeys.pages });
  void queryClient.invalidateQueries({ queryKey: queryKeys.page(page.id) });
}

/** Ask, then delete a page and all its versions. */
export function confirmDeletePage(
  page: Pick<PageSummary, "id" | "title" | "versionCount">,
  onDeleted?: () => void,
) {
  Alert.alert(
    `Delete “${page.title}”?`,
    `${page.versionCount === 1 ? "The page is" : `All ${page.versionCount} versions are`} deleted everywhere, including the chat it was made in. The file it was made from stays on the computer.`,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const result = await safe(api.pages.remove({ pageId: page.id }));
          if (result.error) {
            Alert.alert("Couldn't delete it", errorMessage(result.error));
            return;
          }
          haptics.success();
          onDeleted?.();
          queryClient.removeQueries({ queryKey: queryKeys.page(page.id), exact: true });
          animateLayout();
          void queryClient.invalidateQueries({ queryKey: queryKeys.pages });
        },
      },
    ],
  );
}

/** The menu a held page opens: pin or unpin, and delete. */
export function PageMenu({ page, onClose }: { page: PageSummary | null; onClose: () => void }) {
  const colors = useColors();
  return (
    <Sheet open={page !== null} onClose={onClose} title={page?.title} testID="page-menu">
      {page && (
        <SheetItem
          icon={
            page.pinned ? (
              <PinOff size={20} color={colors.foreground} />
            ) : (
              <Pin size={20} color={colors.foreground} />
            )
          }
          label={page.pinned ? "Unpin" : "Pin to top"}
          onPress={() => {
            onClose();
            void setPagePinned(page, !page.pinned);
          }}
          testID="page-menu-pin"
        />
      )}
      {page && (
        <SheetItem
          icon={<Trash2 size={20} color={colors.destructive} />}
          label="Delete"
          destructive
          onPress={() => {
            onClose();
            confirmDeletePage(page);
          }}
          testID="page-menu-delete"
        />
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingLeft: space(4),
    // The menu button's own 48dp target makes the room on the right.
    paddingRight: space(1),
    paddingVertical: space(3),
    minHeight: 84,
  },
  thumb: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  picture: { width: 72, height: 56, aspectRatio: undefined },
  more: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  meta: { flexDirection: "row", alignItems: "center", gap: space(1.5), marginTop: 2 },
});
