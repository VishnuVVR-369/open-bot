import { Image } from "expo-image";
import { router } from "expo-router";
import { ImageOff } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { fileHeaders, fileName, fileUrl } from "@/features/files/files";
import { radius, useColors } from "@/theme";

/** An image on the computer, as a picture you can tap to see full size. */
export function ImageThumb({ path, name = fileName(path) }: { path: string; name?: string }) {
  const colors = useColors();
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void fileHeaders().then((value) => current && setHeaders(value));
    return () => {
      current = false;
    };
  }, []);
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/file", params: { path, name } })}
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${name}`}
      style={[styles.thumb, { backgroundColor: colors.subtle, borderColor: colors.border }]}
      testID="image-thumb"
    >
      {headers && !failed ? (
        <Image
          source={{ uri: fileUrl(path), headers }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          recyclingKey={path}
          onError={() => setFailed(true)}
        />
      ) : failed ? (
        <View style={styles.center}>
          <ImageOff size={22} color={colors.mutedForeground} />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  thumb: {
    width: 200,
    height: 150,
    borderRadius: radius.xl + 4,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
