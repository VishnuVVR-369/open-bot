import type { ChatSummary } from "@open-bot/api";
import { excerptLine, highlightParts } from "@open-bot/chat-core";
import type { Href } from "expo-router";
import {
  CalendarClock,
  FileText,
  Mail,
  MessageSquare,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { BotAvatar, botActivity, GroupAvatar } from "@/components/bot-avatar";
import { Text } from "@/components/text";
import { useComputerOffline } from "@/lib/queries";
import type { SearchRow as Row } from "@/lib/search";
import { ago } from "@/lib/time";
import { fonts, radius, space, useColors } from "@/theme";

/** A place in the app search can go to. */
export interface AppPlace {
  title: string;
  href: Href;
  icon: LucideIcon;
  keywords: string;
}

export type AppSearchRow = Row<AppPlace>;

const CHAT_ICONS: Record<ChatSummary["kind"], LucideIcon> = {
  direct: MessageSquare,
  helper: MessageSquare,
  group: MessagesSquare,
  scheduled: CalendarClock,
  inbox: Mail,
};

/** One result: a teammate, a chat, a page, a place in the app, or something said. */
export function SearchResultRow({
  row,
  words,
  you,
  onPress,
}: {
  row: AppSearchRow;
  words: string[];
  you: string;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.muted }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.subtle }]}
      accessibilityRole="button"
      testID={`search-${row.kind}`}
    >
      <Leading row={row} you={you} />
      <View style={{ flex: 1, gap: 2 }}>
        {row.kind === "teammate" ? (
          <>
            <Text variant="label" numberOfLines={1}>
              {row.teammate.name}
            </Text>
            <Text variant="small" muted numberOfLines={1}>
              {row.teammate.role}
            </Text>
          </>
        ) : row.kind === "chat" ? (
          <>
            <Text variant="label" numberOfLines={1}>
              {row.title}
            </Text>
            <Text variant="small" muted numberOfLines={1}>
              {row.subtitle}
            </Text>
          </>
        ) : row.kind === "place" ? (
          <Text variant="label">{row.title}</Text>
        ) : row.kind === "page" ? (
          <>
            <Text variant="label" numberOfLines={1}>
              {row.page.title}
            </Text>
            <Text variant="small" muted numberOfLines={1}>
              {[row.teammate?.name ?? "Former teammate", ago(row.page.updatedAt)].join(" · ")}
            </Text>
          </>
        ) : (
          <>
            <View style={styles.messageHead}>
              <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
                {row.who}
                {row.where && (
                  <Text variant="small" muted>
                    {" "}
                    {row.where}
                  </Text>
                )}
              </Text>
              <Text variant="caption" muted style={{ marginLeft: "auto" }}>
                {ago(row.result.createdAt)}
              </Text>
            </View>
            <Highlight text={row.result.excerpt} words={words} />
          </>
        )}
      </View>
    </Pressable>
  );
}

/** A found message's text from shortly before the match, with each word of the query in bold. */
function Highlight({ text, words }: { text: string; words: string[] }) {
  return (
    <Text variant="small" muted numberOfLines={2}>
      {highlightParts(excerptLine(text, words), words).map((part, index) =>
        part.mark ? (
          <Text key={index} variant="small" style={{ fontWeight: "600" }}>
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}

/** A teammate's face for what's theirs, your initial for what you said, an icon for the rest. */
function Leading({ row, you }: { row: AppSearchRow; you: string }) {
  const colors = useColors();
  const computerOffline = useComputerOffline();
  if (row.kind === "chat" && row.members && row.members.length > 1)
    return <GroupAvatar members={row.members} size="md" />;
  if (row.kind === "page")
    return (
      <View style={[styles.mark, { backgroundColor: colors.subtle }]}>
        <FileText size={20} color={colors.foreground} />
      </View>
    );
  const teammate = row.kind === "place" ? undefined : row.teammate;
  if (teammate)
    return (
      <BotAvatar
        name={teammate.name}
        color={teammate.color}
        emoji={teammate.emoji}
        size="md"
        activity={row.kind === "teammate" ? botActivity(teammate, computerOffline) : "idle"}
      />
    );
  if (row.kind === "message")
    return (
      <View style={[styles.mark, styles.you, { backgroundColor: colors.primary }]}>
        <Text
          allowFontScaling={false}
          style={[styles.youText, { color: colors.primaryForeground }]}
        >
          {you}
        </Text>
      </View>
    );
  const Icon =
    row.kind === "chat"
      ? CHAT_ICONS[row.chatKind]
      : row.kind === "place"
        ? row.icon
        : MessageSquare;
  return (
    <View style={[styles.mark, { backgroundColor: colors.subtle }]}>
      <Icon size={20} color={colors.foreground} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(2.5),
    minHeight: 60,
  },
  mark: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  you: { borderRadius: radius.full },
  youText: { fontFamily: fonts.heading, fontWeight: "600", fontSize: 16, lineHeight: 20 },
  messageHead: { flexDirection: "row", alignItems: "center", gap: space(2) },
});
