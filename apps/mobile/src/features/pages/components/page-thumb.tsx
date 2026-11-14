import { Image } from "expo-image";
import { FileText } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, useColorScheme, View, type StyleProp, type ViewStyle } from "react-native";
import { fileHeaders } from "@/features/files/files";
import { pageThumbnailUrl } from "@/features/pages/pages";
import { useColors } from "@/theme";

/** The top of a page version as a picture, or a plain tile when there isn't one (or it's gone). */
export function PageThumb({
  versionId,
  style,
}: {
  versionId: string;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const theme = useColorScheme() === "dark" ? "dark" : "light";
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [versionId, theme]);
  useEffect(() => {
    let current = true;
    void fileHeaders().then((value) => current && setHeaders(value));
    return () => {
      current = false;
    };
  }, []);
  return (
    <View style={[styles.thumb, { backgroundColor: colors.subtle }, style]}>
      {headers && !failed ? (
        <Image
          // A version's picture never changes, so it's cached for good under its id and theme.
          source={{
            uri: pageThumbnailUrl(versionId, theme),
            headers,
            cacheKey: `page-${versionId}-${theme}`,
          }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          contentPosition="top"
          transition={150}
          recyclingKey={`${versionId}-${theme}`}
          cachePolicy="disk"
          onError={() => setFailed(true)}
        />
      ) : failed ? (
        <View style={styles.center}>
          <FileText size={22} color={colors.mutedForeground} strokeWidth={1.6} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  thumb: { aspectRatio: 16 / 10, overflow: "hidden" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
