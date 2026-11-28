import {
  cardBrand,
  cvcInput,
  expiryInput,
  groupCardNumber,
  VAULT_COPY,
  type VaultForm,
} from "@open-bot/domain";
import { Check } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type TextInputProps } from "react-native";
import { Card } from "@/components/section";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { Toggle } from "@/components/toggle";
import { TeammateAvatar } from "@/features/teammates/components/teammate-avatar";
import { haptics } from "@/lib/haptics";
import { radius, space, useColors } from "@/theme";

/**
 * What every field that takes a secret sets: no autofill service offered or asked to save it, no
 * suggestions or learning from the keyboard (Android's keyboards leave `visible-password` alone).
 */
const SECRET_INPUT = {
  autoComplete: "off",
  importantForAutofill: "no",
  autoCorrect: false,
  spellCheck: false,
  autoCapitalize: "none",
} satisfies Partial<TextInputProps>;

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: space(2), flex: 1 }}>
      <Text variant="overline" muted style={styles.inset}>
        {label}
      </Text>
      {children}
      {hint ? (
        <Text variant="caption" muted style={styles.inset}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

type Set = (patch: Partial<VaultForm>) => void;

/** A login's site, username and password. */
export function LoginFields({
  form,
  set,
  editable,
  editing,
}: {
  form: VaultForm;
  set: Set;
  editable: boolean;
  editing: boolean;
}) {
  return (
    <>
      <Field label="Site" hint={VAULT_COPY.siteHint}>
        <TextField
          value={form.domain}
          onChangeText={(domain) => set({ domain })}
          editable={editable}
          placeholder="github.com"
          keyboardType="url"
          {...SECRET_INPUT}
          testID="vault-site-input"
        />
      </Field>
      <Field label="Username or email">
        <TextField
          value={form.username}
          onChangeText={(username) => set({ username })}
          editable={editable}
          keyboardType="visible-password"
          {...SECRET_INPUT}
          testID="vault-username-input"
        />
      </Field>
      <Field label="Password">
        <TextField
          value={form.password}
          onChangeText={(password) => set({ password })}
          editable={editable}
          password
          placeholder={editing ? VAULT_COPY.savedPlaceholder : undefined}
          {...SECRET_INPUT}
          testID="vault-password-input"
        />
      </Field>
    </>
  );
}

/** A card's number, expiry, security code, ZIP code and name. */
export function CardFields({
  form,
  set,
  editable,
  editing,
  hint,
}: {
  form: VaultForm;
  set: Set;
  editable: boolean;
  editing: boolean;
  /** The saved card's "Visa •••• 4242", shown while its number is left alone. */
  hint: string | null;
}) {
  const brand = form.number ? cardBrand(form.number) : null;
  const saved = editing ? "Saved" : undefined;
  return (
    <>
      <Field label="Card number">
        <TextField
          value={form.number}
          onChangeText={(number) => set({ number: groupCardNumber(number) })}
          editable={editable}
          placeholder={hint ?? "4242 4242 4242 4242"}
          keyboardType="number-pad"
          mono
          {...SECRET_INPUT}
          trailing={
            brand && brand !== "Card" ? (
              <Text variant="small" muted style={styles.brand}>
                {brand}
              </Text>
            ) : null
          }
          testID="vault-number-input"
        />
      </Field>
      <View style={styles.pair}>
        <Field label="Expiry">
          <TextField
            value={form.expiry}
            onChangeText={(expiry) => set({ expiry: expiryInput(expiry) })}
            editable={editable}
            placeholder={saved ?? "MM/YY"}
            keyboardType="number-pad"
            mono
            {...SECRET_INPUT}
            testID="vault-expiry-input"
          />
        </Field>
        <Field label="Security code">
          <TextField
            value={form.cvc}
            onChangeText={(cvc) => set({ cvc: cvcInput(cvc) })}
            editable={editable}
            password
            placeholder={saved ?? "123"}
            keyboardType="number-pad"
            {...SECRET_INPUT}
            testID="vault-cvc-input"
          />
        </Field>
      </View>
      <Field label="Name on the card">
        <TextField
          value={form.holder}
          onChangeText={(holder) => set({ holder })}
          editable={editable}
          placeholder={editing ? VAULT_COPY.savedPlaceholder : undefined}
          keyboardType="visible-password"
          {...SECRET_INPUT}
          testID="vault-holder-input"
        />
      </Field>
      <Field label="ZIP code">
        <TextField
          value={form.zip}
          onChangeText={(zip) => set({ zip })}
          editable={editable}
          placeholder={saved ?? "Optional"}
          keyboardType="visible-password"
          {...SECRET_INPUT}
          testID="vault-zip-input"
        />
      </Field>
    </>
  );
}

/** Every teammate, or the ones you pick, as the web's picker offers them. */
export function AccessPicker({
  value,
  onChange,
  teammates,
  disabled,
}: {
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  teammates: readonly { id: string; name: string; color: string; emoji?: string }[];
  disabled: boolean;
}) {
  const colors = useColors();
  const everyone = value === null;
  return (
    <Card>
      <Pressable
        onPress={() => {
          haptics.tap();
          onChange(everyone ? [] : null);
        }}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityState={{ checked: everyone, disabled }}
        accessibilityLabel={VAULT_COPY.everyone}
        style={styles.everyone}
        testID="vault-everyone"
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label">{VAULT_COPY.everyone}</Text>
          <Text variant="small" muted>
            {VAULT_COPY.everyoneHint}
          </Text>
        </View>
        <Toggle
          value={everyone}
          disabled={disabled}
          importantForAccessibility="no-hide-descendants"
        />
      </Pressable>
      {!everyone && (
        <View
          style={[styles.chips, { borderTopColor: colors.border }]}
          accessibilityLabel="Teammates who can use it"
        >
          {teammates.map((teammate) => {
            const on = value.includes(teammate.id);
            return (
              <Pressable
                key={teammate.id}
                onPress={() => {
                  haptics.tap();
                  onChange(on ? value.filter((id) => id !== teammate.id) : [...value, teammate.id]);
                }}
                disabled={disabled}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled }}
                accessibilityLabel={teammate.name}
                style={[
                  styles.chip,
                  on
                    ? { borderColor: colors.foreground, backgroundColor: colors.subtle }
                    : { borderColor: colors.input },
                ]}
                testID={`vault-access-${teammate.id}`}
              >
                <TeammateAvatar
                  name={teammate.name}
                  color={teammate.color}
                  emoji={teammate.emoji}
                  size="xs"
                />
                <Text
                  variant="small"
                  style={{ color: on ? colors.foreground : colors.mutedForeground }}
                >
                  {teammate.name}
                </Text>
                {on && <Check size={14} color={colors.foreground} />}
              </Pressable>
            );
          })}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  inset: { paddingHorizontal: space(1) },
  pair: { flexDirection: "row", gap: space(3) },
  brand: { paddingRight: space(4), fontWeight: "600" },
  everyone: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    padding: space(4),
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space(2),
    padding: space(4),
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    minHeight: 36,
    paddingLeft: space(1.5),
    paddingRight: space(3),
    borderWidth: 1,
    borderRadius: radius.xl,
  },
});
