import type { BotSummary } from "@open-bot/api";
import { Users } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import { BotAvatar } from "@/components/bot-avatar";
import { Empty } from "@/components/states";
import { useColors } from "@/theme";

/** A chat with nothing in it yet: who it's with and what to do. */
export function ChatEmpty({
  teammate,
  isGroup,
}: {
  /** The teammate of a chat that isn't a group. */
  teammate: BotSummary | undefined;
  isGroup: boolean;
}) {
  const colors = useColors();
  return (
    <View style={styles.empty}>
      <Empty
        icon={
          teammate ? (
            <BotAvatar
              name={teammate.name}
              color={teammate.color}
              emoji={teammate.emoji}
              size="lg"
            />
          ) : (
            <Users size={28} color={colors.mutedForeground} />
          )
        }
        title={
          isGroup ? "Start the conversation" : `Give ${teammate?.name ?? "them"} something to do`
        }
        body={
          isGroup
            ? "Your message goes to the lead teammate. They pass work to each other."
            : `${teammate?.name ?? "Your teammate"} works on the shared computer while you're away.`
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // No transform: the inverted list already flips its empty state back (both axes on Android),
  // and a transform here would replace that flip and leave the text mirrored.
  empty: { flex: 1 },
});
