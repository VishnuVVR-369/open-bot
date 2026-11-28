import type { KeyboardTypeOptions } from "react-native";

/**
 * The keyboard for a password field. Shown, it's the visible-password keyboard, which learns
 * nothing and suggests nothing, so a revealed password never ends up in the keyboard's dictionary.
 * A number pad (a card's security code) stays one: it has no dictionary.
 */
export function passwordKeyboard(
  keyboardType: KeyboardTypeOptions | undefined,
  password: boolean,
  shown: boolean,
): KeyboardTypeOptions | undefined {
  if (!password || !shown) return keyboardType;
  return keyboardType === undefined || keyboardType === "default"
    ? "visible-password"
    : keyboardType;
}
