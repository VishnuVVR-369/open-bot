import { Camera, FileUp, Image as ImageIcon } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import type { AttachSource } from "@/features/chat/picked-files";
import { radius, space, useColors } from "@/theme";

const SOURCES = [
  { source: "camera", label: "Camera", Icon: Camera, testID: "attach-camera" },
  { source: "photos", label: "Photos", Icon: ImageIcon, testID: "attach-photos" },
  { source: "files", label: "Files", Icon: FileUp, testID: "attach-files" },
] as const;

/** Where to attach from: a new photo, your photos, or your files. */
export function AttachSheet({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (source: AttachSource) => void;
}) {
  const colors = useColors();
  return (
    <Sheet open={open} onClose={onClose} testID="attach-sheet">
      <View style={styles.grid}>
        {SOURCES.map(({ source, label, Icon, testID }) => (
          <Pressable
            key={source}
            onPress={() => {
              haptics.tap();
              onPick(source);
            }}
            accessibilityRole="button"
            accessibilityLabel={source === "camera" ? "Take a photo" : label}
            android_ripple={{ color: colors.muted }}
            style={[styles.tile, { backgroundColor: colors.subtle }]}
            testID={testID}
          >
            <View style={[styles.icon, { backgroundColor: colors.surface }]}>
              <Icon size={22} color={colors.foreground} />
            </View>
            <Text variant="small" style={{ fontWeight: "500" }}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    gap: space(3),
    paddingHorizontal: space(5),
    paddingTop: space(1),
    paddingBottom: space(2),
  },
  tile: {
    flex: 1,
    alignItems: "center",
    gap: space(2),
    paddingVertical: space(4),
    borderRadius: radius.xl,
    overflow: "hidden",
  },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
});
