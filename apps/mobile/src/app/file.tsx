import { fileKind } from "@open-bot/shared";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams } from "expo-router";
import { ExternalLink } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { Markdown } from "@/components/markdown";
import { LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { errorMessage } from "@/lib/errors";
import { fileHeaders, fileName, fileUrl, openInApp, readTextFile } from "@/lib/files";
import { queryKeys } from "@/lib/query";
import { fonts, radius, space, useColors } from "@/theme";

/** The most of a text file shown here; the rest opens in another app. */
const MAX_CHARS = 200_000;
const MAX_ROWS = 300;

/** Rows and cells of a CSV or TSV, quotes and all. */
function parseTable(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length && rows.length < MAX_ROWS; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

function Table({ rows }: { rows: string[][] }) {
  const colors = useColors();
  const width = Math.max(...rows.map((row) => row.length));
  return (
    <ScrollView>
      <ScrollView horizontal contentContainerStyle={{ padding: space(4) }}>
        <View style={[styles.table, { borderColor: colors.border }]}>
          {rows.map((row, index) => (
            <View
              key={index}
              style={[
                styles.tableRow,
                { borderColor: colors.border },
                index === 0 && { backgroundColor: colors.subtle },
              ]}
            >
              {Array.from({ length: width }, (_, column) => (
                <Text
                  key={column}
                  variant="small"
                  numberOfLines={3}
                  style={[
                    styles.cell,
                    { borderColor: colors.border, color: colors.foreground },
                    index === 0 && { fontWeight: "600" },
                  ]}
                >
                  {row[column] ?? ""}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

function TextPreview({ path, kind }: { path: string; kind: "markdown" | "csv" | "text" }) {
  const colors = useColors();
  const query = useQuery({ queryKey: queryKeys.file(path), queryFn: () => readTextFile(path) });
  const text = query.data ?? "";
  const cut = text.length > MAX_CHARS;
  const shown = cut ? text.slice(0, MAX_CHARS) : text;
  const rows = useMemo(
    () =>
      kind === "csv" ? parseTable(shown, path.toLowerCase().endsWith(".tsv") ? "\t" : ",") : [],
    [kind, shown, path],
  );
  if (query.isLoading) return <Loading />;
  if (query.error) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  if (kind === "csv") return <Table rows={rows} />;
  return (
    <ScrollView contentContainerStyle={{ padding: space(4), gap: space(3) }}>
      {kind === "markdown" ? (
        <Markdown text={shown} />
      ) : (
        <ScrollView horizontal>
          <Text
            selectable
            style={{
              fontFamily: fonts.mono,
              fontSize: 12.5,
              lineHeight: 18,
              color: colors.foreground,
            }}
          >
            {shown}
          </Text>
        </ScrollView>
      )}
      {cut && (
        <Text variant="small" muted>
          This is the start of a long file. Open it in another app to see the rest.
        </Text>
      )}
    </ScrollView>
  );
}

function ImagePreview({ path }: { path: string }) {
  const colors = useColors();
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void fileHeaders().then(setHeaders);
  }, []);
  if (!headers) return <Loading />;
  if (failed)
    return (
      <LoadError error={new Error("The image didn't load.")} onRetry={() => setFailed(false)} />
    );
  return (
    <Image
      source={{ uri: fileUrl(path), headers }}
      style={{ flex: 1, backgroundColor: colors.background }}
      contentFit="contain"
      transition={150}
      onError={() => setFailed(true)}
      accessibilityLabel={fileName(path)}
    />
  );
}

/** Nothing to show here: open it in an app that can, like a PDF viewer. */
function OpenElsewhere({
  name,
  opening,
  problem,
  onOpen,
}: {
  name: string;
  opening: boolean;
  problem: string | null;
  onOpen: () => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.center}>
      <Text variant="heading" style={{ textAlign: "center" }}>
        {name}
      </Text>
      <Text muted style={{ textAlign: "center" }}>
        Open it in an app on this phone that can show it.
      </Text>
      {problem && (
        <Text variant="small" style={{ color: colors.destructive, textAlign: "center" }}>
          {problem}
        </Text>
      )}
      <Button
        title="Open"
        icon={<ExternalLink size={16} color={colors.primaryForeground} />}
        busy={opening}
        onPress={onOpen}
        style={{ marginTop: space(2), minWidth: 160 }}
        testID="open-file"
      />
    </View>
  );
}

/** A file from the computer: images and text right here, anything else in another app. */
export default function FileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  // An attachment knows the name you gave it; its path on the computer starts with the upload id.
  const params = useLocalSearchParams<{ path: string; name?: string }>();
  const path = params.path;
  const name = params.name || fileName(path);
  const kind = fileKind(name);
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function open() {
    setOpening(true);
    setProblem(null);
    try {
      await openInApp(path, name);
    } catch (error) {
      setProblem(errorMessage(error, "Couldn't open the file."));
    } finally {
      setOpening(false);
    }
  }

  return (
    <View style={{ flex: 1, paddingBottom: insets.bottom }}>
      <Stack.Screen
        options={{
          title: name,
          headerRight: () =>
            kind === "pdf" || kind === "other" ? null : opening ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <Pressable
                onPress={() => void open()}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Open in another app"
              >
                <ExternalLink size={20} color={colors.foreground} />
              </Pressable>
            ),
        }}
      />
      {kind === "image" ? (
        <ImagePreview path={path} />
      ) : kind === "markdown" || kind === "csv" || kind === "text" ? (
        <TextPreview path={path} kind={kind} />
      ) : (
        <OpenElsewhere name={name} opening={opening} problem={problem} onOpen={() => void open()} />
      )}
      {problem && kind !== "pdf" && kind !== "other" && (
        <Text variant="small" style={[styles.problem, { color: colors.destructive }]}>
          {problem}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space(8),
    gap: space(2),
  },
  table: { borderWidth: 1, borderRadius: radius.md, overflow: "hidden" },
  tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  cell: {
    width: 140,
    paddingHorizontal: space(2.5),
    paddingVertical: space(2),
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  problem: { textAlign: "center", padding: space(3) },
});
