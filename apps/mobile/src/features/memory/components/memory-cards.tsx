import { memoryExpired } from "@open-bot/domain";
import { Sparkles, X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Card } from "@/components/section";
import { Text } from "@/components/text";
import { Toggle } from "@/components/toggle";
import { haptics } from "@/lib/haptics";
import { space, useColors } from "@/theme";
import { expiryLabel, type MemoryForm } from "../memory";

/**
 * A teammate's suggested memory, to confirm or dismiss. Confirming takes the suggestion as saved,
 * so it waits while the form has changes of yours.
 */
export function SuggestionCard({
  by,
  busy,
  disabled,
  changed,
  onConfirm,
  onDismiss,
}: {
  /** The teammate that suggested it, by name, when known. */
  by: string | null;
  busy: "save" | "confirm" | "forget" | "reload" | null;
  disabled: boolean;
  changed: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const colors = useColors();
  return (
    <Card>
      <View style={styles.suggestion} testID="memory-suggestion">
        <View style={styles.head}>
          <Sparkles size={18} color={colors.attentionInk} />
          <Text variant="label" style={{ flex: 1 }}>
            {`${by ?? "A teammate"} suggested this`}
          </Text>
        </View>
        <Text variant="small" muted>
          It counts as memory once you confirm it.
        </Text>
        <View style={styles.buttons}>
          <Button
            title="Dismiss"
            variant="outline"
            onPress={onDismiss}
            disabled={disabled}
            busy={busy === "forget"}
            style={{ flex: 1 }}
            testID="memory-dismiss"
          />
          <Button
            title="Confirm"
            onPress={onConfirm}
            disabled={disabled || changed}
            busy={busy === "confirm"}
            style={{ flex: 1 }}
            testID="memory-confirm"
          />
        </View>
        {changed && (
          <Text variant="caption" muted>
            Save or undo your changes to confirm it.
          </Text>
        )}
      </View>
    </Card>
  );
}

/** Whether teammates always get the memory, and when it expires (set on the web, cleared here). */
export function MemoryOptions({
  form,
  disabled,
  onChange,
}: {
  form: MemoryForm;
  disabled: boolean;
  onChange: (patch: Partial<MemoryForm>) => void;
}) {
  const colors = useColors();
  return (
    <Card>
      <Pressable
        onPress={() => onChange({ pinned: !form.pinned })}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityState={{ checked: form.pinned, disabled }}
        android_ripple={{ color: colors.muted }}
        style={styles.row}
        testID="memory-pinned"
      >
        <View style={styles.text}>
          <Text variant="label">Prioritize</Text>
          <Text variant="small" muted>
            Teammates get it with every task.
          </Text>
        </View>
        <Toggle value={form.pinned} importantForAccessibility="no-hide-descendants" />
      </Pressable>
      {form.expiresAt && (
        <View style={[styles.row, styles.divided, { borderTopColor: colors.border }]}>
          <View style={styles.text}>
            <Text variant="label">{expiryLabel(form.expiresAt)}</Text>
            <Text variant="small" muted>
              {memoryExpired(form)
                ? "Teammates no longer get it. Clear this to keep it."
                : "Then teammates stop getting it."}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              haptics.tap();
              onChange({ expiresAt: null });
            }}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Clear the expiry"
            android_ripple={{ color: colors.muted, borderless: true, radius: 20 }}
            style={styles.clear}
            testID="memory-expiry-clear"
          >
            <X size={18} color={colors.mutedForeground} />
          </Pressable>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  suggestion: { padding: space(4), gap: space(2.5) },
  head: { flexDirection: "row", alignItems: "center", gap: space(2) },
  buttons: { flexDirection: "row", gap: space(3), marginTop: space(1) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    minHeight: 64,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
  },
  text: { flex: 1, gap: 2 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth },
  clear: {
    width: 36,
    height: 36,
    marginRight: -space(2),
    alignItems: "center",
    justifyContent: "center",
  },
});
