import { ChevronDown } from "lucide-react-native";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type TextLayoutEvent,
  type TextStyle,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Text } from "@/components/text";
import { haptics } from "@/lib/haptics";
import { FOLDED_LINES, folds, mightFold } from "@/lib/fold";
import { space } from "@/theme";
import { mix } from "@/theme/mix";

/**
 * Lets an opened message keep its first line where it was. The chat list is inverted, so a row
 * that grows would push up from its bottom edge. `open` pins the rows older than `row`, then
 * calls `then` to open the message; `opened` releases the pin once the open message is committed.
 */
export type KeepTop = { open: (row: number, then: () => void) => void; opened: () => void };

export const KeepTopContext = createContext<KeepTop | null>(null);

/** The chat list row a message is in, for `KeepTopContext`. */
export const RowContext = createContext<number | null>(null);

/** How many lines the text takes, and where its first `FOLDED_LINES` end. */
type Extent = { lines: number; folded: number };

/**
 * Text that folds to its first few lines when it's long, fading into `background` above a
 * "Show more" toggle. `lineHeight` must be set in `style`; the fold is cut on a line boundary.
 */
export function FoldableText({
  text,
  style,
  background,
  foreground,
}: {
  text: string;
  style: TextStyle & { lineHeight: number };
  background: string;
  foreground: string;
}) {
  const { fontScale } = useWindowDimensions();
  const keepTop = useContext(KeepTopContext);
  const row = useContext(RowContext);
  const [extent, setExtent] = useState<Extent | null>(null);
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  useEffect(() => {
    if (!open || !pinned.current) return;
    pinned.current = false;
    keepTop?.opened();
  }, [open, keepTop]);
  const gradient = `fold${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const candidate = mightFold(text);
  if (!candidate)
    return (
      <Text style={style} selectable>
        {text}
      </Text>
    );

  // Until the text is laid out, a likely-long message starts folded, so it never flashes open.
  const long = extent ? folds(extent.lines) : true;
  const folded = long && !open;
  const line = style.lineHeight * fontScale;
  const foldedHeight = extent?.folded ?? line * FOLDED_LINES;
  const muted = mix(foreground, background, 0.62);

  const onTextLayout = (event: TextLayoutEvent) => {
    const lines = event.nativeEvent.lines;
    const last = lines.at(-1);
    const cut = lines[FOLDED_LINES - 1];
    if (!last) return;
    setExtent({ lines: lines.length, folded: cut ? cut.y + cut.height : last.y + last.height });
  };

  return (
    <View>
      <View style={folded ? { maxHeight: foldedHeight, overflow: "hidden" } : undefined}>
        <Text style={style} selectable onTextLayout={onTextLayout} testID="message-body">
          {text}
        </Text>
        {folded && (
          <View pointerEvents="none" style={[styles.fade, { height: line * 2.5 }]}>
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={background} stopOpacity="0" />
                  <Stop offset="1" stopColor={background} stopOpacity="1" />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill={`url(#${gradient})`} />
            </Svg>
          </View>
        )}
      </View>
      {long && (
        <Pressable
          onPress={() => {
            haptics.tap();
            if (open) setOpen(false);
            else if (keepTop && row !== null)
              keepTop.open(row, () => {
                pinned.current = true;
                setOpen(true);
              });
            else setOpen(true);
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
          style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.6 }]}
          testID="message-toggle"
        >
          <Text variant="small" style={{ color: muted, fontWeight: "500" }}>
            {open ? "Show less" : "Show more"}
          </Text>
          <ChevronDown
            size={14}
            color={muted}
            style={open ? { transform: [{ rotate: "180deg" }] } : undefined}
          />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fade: { position: "absolute", left: 0, right: 0, bottom: 0 },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space(1),
    marginTop: space(1.5),
  },
});
