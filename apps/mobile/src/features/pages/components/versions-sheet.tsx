import type { PageDetail } from "@open-bot/api";
import { Check } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";

/** A page's versions, newest first, with the one on screen checked and the latest marked. */
export function VersionsSheet({
  open,
  onClose,
  page,
  shownId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  page: PageDetail;
  shownId: string;
  onPick: (versionId: string) => void;
}) {
  const colors = useColors();
  return (
    <Sheet open={open} onClose={onClose} title="Versions" testID="page-versions">
      <ScrollView style={{ maxHeight: 420 }}>
        {page.versions.map((version) => (
          <Pressable
            key={version.id}
            onPress={() => {
              onClose();
              onPick(version.id);
            }}
            android_ripple={{ color: colors.muted }}
            accessibilityRole="button"
            accessibilityState={{ selected: version.id === shownId }}
            style={styles.version}
            testID="page-version"
          >
            <View style={styles.versionCheck}>
              {version.id === shownId && <Check size={18} color={colors.foreground} />}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={styles.versionTitle}>
                <Text variant="label">Version {version.number}</Text>
                {version.id === page.versionId && (
                  <View style={[styles.badge, { backgroundColor: colors.subtle }]}>
                    <Text variant="caption" muted style={{ fontWeight: "500" }}>
                      Latest
                    </Text>
                  </View>
                )}
              </View>
              {version.note ? (
                <Text variant="small" muted numberOfLines={2}>
                  {version.note}
                </Text>
              ) : null}
              <Text variant="caption" muted>
                {ago(version.createdAt)}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  version: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingHorizontal: space(5),
    paddingVertical: space(3),
  },
  versionCheck: { width: 22, alignItems: "center", paddingTop: 1 },
  versionTitle: { flexDirection: "row", alignItems: "center", gap: space(2) },
  badge: { borderRadius: 5, paddingHorizontal: 6 },
});
