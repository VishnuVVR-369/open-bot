import { useSafeAreaInsets } from "react-native-safe-area-context";
import { space } from "@/theme";

/**
 * The bottom padding for a scrolling screen's content: clear of the gesture bar, and 24dp more,
 * so the last row never sits under the system navigation. A tab screen already ends above the
 * tab bar, which keeps clear of the gesture bar itself.
 */
export function useSafeBottom({ tabs = false }: { tabs?: boolean } = {}): number {
  const insets = useSafeAreaInsets();
  return (tabs ? 0 : insets.bottom) + space(6);
}
