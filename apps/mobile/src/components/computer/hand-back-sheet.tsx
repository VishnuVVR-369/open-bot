import { Alert, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Sheet } from "@/components/sheet";
import { TextField } from "@/components/text-field";
import { space } from "@/theme";

/**
 * Asks before the owner hands a screen back, with a note for the teammate. `canClearCode` offers to
 * forget a code the owner typed, which discards the screen's pages if the computer restarted.
 */
export function HandBackSheet({
  open,
  onClose,
  note,
  onNote,
  busy,
  canClearCode,
  onHandBack,
}: {
  open: boolean;
  onClose: () => void;
  note: string;
  onNote: (note: string) => void;
  busy: boolean;
  canClearCode: boolean;
  onHandBack: (clearCode: boolean) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Hand the screen back"
      description="Your teammate will take a screenshot and continue."
    >
      <View style={styles.sheetBody}>
        <TextField
          value={note}
          onChangeText={onNote}
          placeholder="Optional note, such as Logged in, continue"
          multiline
          maxLength={2000}
          testID="hand-back-note"
        />
        <Button
          title="Hand back"
          onPress={() => onHandBack(false)}
          busy={busy}
          testID="hand-back-confirm"
        />
        {canClearCode && (
          <Button
            title="Clear the code and hand back"
            variant="outline"
            busy={busy}
            onPress={() =>
              Alert.alert(
                "Clear code and hand back?",
                "If the computer restarted, this discards all pages on this screen to keep the forgotten code private.",
                [
                  { text: "Keep control", style: "cancel" },
                  { text: "Clear and hand back", onPress: () => onHandBack(true) },
                ],
              )
            }
            testID="clear-code-hand-back"
          />
        )}
        <Button title="Stay in control" variant="ghost" onPress={onClose} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sheetBody: { paddingHorizontal: space(5), gap: space(3) },
});
