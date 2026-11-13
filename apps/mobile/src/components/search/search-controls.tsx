import { Search as SearchIcon, X } from "lucide-react-native";
import type { RefObject } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type TextInputInstance,
} from "react-native";
import { Text } from "@/components/text";
import { SCOPES, type Scope } from "@/lib/search";
import { fonts, radius, space, useColors } from "@/theme";

/** The search field in the header, with a spinner while messages load and a way to clear it. */
export function SearchField({
  input,
  text,
  onChangeText,
  searching,
}: {
  input: RefObject<TextInputInstance | null>;
  text: string;
  onChangeText: (text: string) => void;
  searching: boolean;
}) {
  const colors = useColors();
  return (
    <View style={[styles.field, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <SearchIcon size={18} color={colors.mutedForeground} />
      <TextInput
        value={text}
        ref={input}
        onChangeText={onChangeText}
        placeholder="Search teammates, chats, pages"
        placeholderTextColor={colors.mutedForeground}
        cursorColor={colors.foreground}
        selectionColor={colors.input}
        returnKeyType="search"
        autoCorrect={false}
        style={[styles.input, { color: colors.foreground }]}
        testID="search-input"
      />
      {searching ? (
        <ActivityIndicator size={16} color={colors.mutedForeground} />
      ) : text ? (
        <Pressable
          onPress={() => {
            onChangeText("");
            input.current?.focus();
          }}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Clear"
        >
          <X size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** The row of scopes under the field: everything, or one kind of thing. */
export function ScopeChips({ scope, onPick }: { scope: Scope; onPick: (scope: Scope) => void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.chipBar}
      contentContainerStyle={styles.chips}
    >
      {SCOPES.map((entry) => (
        <Chip
          key={entry.key}
          label={entry.label}
          selected={scope === entry.key}
          onPress={() => onPick(entry.key)}
        />
      ))}
    </ScrollView>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8 }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Search ${label.toLowerCase()}`}
      testID={`search-scope-${label.toLowerCase()}`}
      style={[
        styles.chip,
        selected
          ? { backgroundColor: colors.primary, borderColor: colors.primary }
          : { backgroundColor: colors.surface, borderColor: colors.input },
      ]}
    >
      <Text
        variant="small"
        style={{
          color: selected ? colors.primaryForeground : colors.foreground,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    height: 44,
    // A pill, like the chat composer.
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingLeft: space(3.5),
    paddingRight: space(3),
    // The header leaves room for the back button.
    width: "100%",
    minWidth: 260,
  },
  input: { flex: 1, fontFamily: fonts.sans, fontSize: 15, paddingVertical: 0 },
  chipBar: { flexGrow: 0 },
  chips: {
    gap: space(2),
    paddingHorizontal: space(4),
    paddingTop: space(1),
    paddingBottom: space(2),
  },
  chip: {
    height: 32,
    paddingHorizontal: space(3.5),
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: "center",
  },
});
