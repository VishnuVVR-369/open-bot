import { fileKind } from "@open-bot/domain";
import { router } from "expo-router";
import {
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  File as FileIcon,
} from "lucide-react-native";
import { Pressable, StyleSheet } from "react-native";
import { Text } from "@/components/text";
import { fileName } from "@/features/files/files";
import { radius, space, useColors } from "@/theme";

const ICONS = {
  image: FileImage,
  pdf: FileText,
  markdown: FileText,
  csv: FileSpreadsheet,
  text: FileCode,
  other: FileIcon,
} as const;

/** A file on the computer, by name. Tap it to see it. */
export function FileChip({ path, name = fileName(path) }: { path: string; name?: string }) {
  const colors = useColors();
  const Icon = ICONS[fileKind(name)];
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/file", params: { path, name } })}
      android_ripple={{ color: colors.muted }}
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}`}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: colors.border, backgroundColor: pressed ? colors.subtle : colors.surface },
      ]}
      testID="file-chip"
    >
      <Icon size={14} color={colors.mutedForeground} />
      <Text variant="small" numberOfLines={1} style={{ flexShrink: 1, fontSize: 13.5 }}>
        {name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: space(2.5),
    minHeight: 34,
    maxWidth: 260,
    overflow: "hidden",
  },
});
