import { AUTONOMY_OPTIONS, lastGlyph, TEAMMATE_COLORS, type Autonomy } from "@open-bot/domain";
import { Check } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { haptics } from "@/lib/haptics";
import { radius, space, useColors } from "@/theme";

/** How much a teammate asks before acting, as the web's three cards, one picked. */
export function AutonomyPicker({
  value,
  onChange,
  disabled,
}: {
  value: Autonomy;
  onChange: (autonomy: Autonomy) => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: space(2) }} accessibilityRole="radiogroup">
      {AUTONOMY_OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => {
              if (selected || disabled) return;
              haptics.tap();
              onChange(option.value);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={option.label}
            accessibilityHint={option.description}
            android_ripple={disabled ? undefined : { color: colors.muted }}
            style={[
              styles.option,
              {
                backgroundColor: colors.surface,
                borderColor: selected ? colors.foreground : colors.border,
              },
              disabled && { opacity: 0.6 },
            ]}
            testID={`autonomy-${option.value}`}
          >
            <View
              style={[
                styles.radio,
                { borderColor: selected ? colors.foreground : colors.input },
                selected && { backgroundColor: colors.foreground },
              ]}
            >
              {selected && <View style={[styles.dot, { backgroundColor: colors.surface }]} />}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="label">{option.label}</Text>
              <Text variant="small" muted>
                {option.description}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The avatar's color, from the team's palette. */
export function ColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Color">
      {TEAMMATE_COLORS.map((color, index) => {
        const selected = color.toLowerCase() === value.toLowerCase();
        return (
          <Pressable
            key={color}
            onPress={() => {
              if (selected || disabled) return;
              haptics.tap();
              onChange(color);
            }}
            hitSlop={4}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={`Color ${index + 1} of ${TEAMMATE_COLORS.length}`}
            style={[
              styles.swatchRing,
              { borderColor: selected ? color : "transparent" },
              disabled && { opacity: 0.6 },
            ]}
            testID={`teammate-color-${index}`}
          >
            <View style={[styles.swatch, { backgroundColor: color }]}>
              {selected && <Check size={16} color="#FFFFFF" strokeWidth={3} />}
            </View>
          </Pressable>
        );
      })}
      {/* A color from before the palette (or set by a teammate) still shows as picked. */}
      {!TEAMMATE_COLORS.some((color) => color.toLowerCase() === value.toLowerCase()) && (
        <View
          style={[styles.swatchRing, { borderColor: value }]}
          accessibilityLabel="Its color now"
        >
          <View style={[styles.swatch, { backgroundColor: value }]}>
            <Check size={16} color="#FFFFFF" strokeWidth={3} />
          </View>
        </View>
      )}
    </View>
  );
}

/** An emoji for the avatar, one character, or none for the name's initial. */
export function EmojiField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (emoji: string) => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={styles.emojiRow}>
      <TextField
        value={value}
        onChangeText={(text) => onChange(lastGlyph(text))}
        editable={!disabled}
        accessibilityLabel="Emoji"
        style={styles.emojiBox}
        textAlign="center"
        selectTextOnFocus
        testID="teammate-emoji-input"
      />
      {value ? (
        <Pressable
          onPress={() => {
            haptics.tap();
            onChange("");
          }}
          disabled={disabled}
          accessibilityRole="button"
          hitSlop={8}
          style={{ flex: 1 }}
          testID="teammate-emoji-clear"
        >
          <Text variant="small" style={{ color: colors.foreground, fontWeight: "600" }}>
            Use the initial instead
          </Text>
        </Pressable>
      ) : (
        <Text variant="small" muted style={{ flex: 1 }}>
          Leave it empty to show the name's initial.
        </Text>
      )}
    </View>
  );
}

const SWATCH = 32;
const RING = 2;
const AIR = 2;

const styles = StyleSheet.create({
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    overflow: "hidden",
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    marginTop: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: space(2),
  },
  swatchRing: {
    width: SWATCH + (RING + AIR) * 2,
    height: SWATCH + (RING + AIR) * 2,
    borderRadius: (SWATCH + (RING + AIR) * 2) / 2,
    borderWidth: RING,
    alignItems: "center",
    justifyContent: "center",
  },
  swatch: {
    width: SWATCH,
    height: SWATCH,
    borderRadius: SWATCH / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  emojiRow: { flexDirection: "row", alignItems: "center", gap: space(3) },
  emojiBox: { width: 56, flexGrow: 0, flexShrink: 0 },
});
