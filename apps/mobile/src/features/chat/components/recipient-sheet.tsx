import { ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { useKeyboardHeight } from "@/lib/use-keyboard";
import { space } from "@/theme";
import { MemberOption, type Member } from "./mention-menu";

/** Each option's height, so the list can show at least two of them. */
const ROW = 52;

/**
 * Who an unsent reply should be for, from the chat's members: instead of a teammate who left the
 * chat, or someone else. A group can have many, so the list scrolls inside a sheet that stays
 * within the screen, in landscape and with the keyboard up too.
 */
export function RecipientSheet<M extends Member>({
  open,
  options,
  onPick,
  onClose,
}: {
  open: boolean;
  options: M[];
  onPick: (member: M) => void;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardHeight();
  // About half of what the keyboard leaves, so the sheet's title and the screen above still show.
  const maxHeight = Math.max(ROW * 2, Math.min(420, (height - keyboard) * 0.5));
  return (
    <Sheet open={open} onClose={onClose} title="Who is it for?" testID="recipient-picker">
      {options.length > 0 ? (
        <ScrollView
          style={{ maxHeight }}
          persistentScrollbar
          keyboardShouldPersistTaps="handled"
          testID="recipient-options"
        >
          {options.map((member) => (
            <MemberOption
              key={member.id}
              member={member}
              onPick={onPick}
              style={styles.option}
              testID="recipient-option"
            />
          ))}
        </ScrollView>
      ) : (
        <Text variant="small" muted style={styles.empty}>
          There's no one else in this chat to send it to.
        </Text>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  option: { minHeight: ROW, paddingHorizontal: space(5), gap: space(3.5) },
  empty: { paddingHorizontal: space(5), paddingBottom: space(2) },
});
