import { Fragment, useMemo, type ReactNode } from "react";
import {
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Renderer, useMarkdown, type MarkedStyles } from "react-native-marked";
import { CodeScroll } from "@/components/code-scroll";
import { fonts, radius, space, useColors } from "@/theme";

/**
 * Lists drawn like the web's: a round bullet (or the number) centered on the item's first line,
 * and items as close together as lines of text. Code blocks keep their box still while long
 * lines scroll inside it, with a fade at the edge and a copy button.
 */
class AppRenderer extends Renderer {
  constructor(
    private readonly marker: string,
    private readonly lineHeight: number,
  ) {
    super();
  }

  override code(
    text: string,
    _language?: string,
    containerStyle?: ViewStyle,
    textStyle?: TextStyle,
  ): ReactNode {
    const { padding, backgroundColor, ...box } = StyleSheet.flatten(containerStyle) ?? {};
    return (
      <CodeScroll
        key={this.getKey()}
        copyText={text.replace(/\n$/, "")}
        background={typeof backgroundColor === "string" ? backgroundColor : undefined}
        padding={typeof padding === "number" ? padding : space(3)}
        style={box}
      >
        <Text selectable style={textStyle}>
          {text}
        </Text>
      </CodeScroll>
    );
  }

  /**
   * Inline code: a soft tint of the text color with a little air on each side. Android can't round
   * or pad a span inside a paragraph, so the air is a narrow no-break space in the body font, and
   * the span keeps the paragraph's line height so the line doesn't grow.
   */
  override codespan(text: string, styles?: TextStyle): ReactNode {
    const pad = { fontFamily: fonts.sans, fontSize: 15 };
    return (
      <Text key={this.getKey()} style={styles}>
        <Text style={pad}>{"\u202F"}</Text>
        {text}
        <Text style={pad}>{"\u202F"}</Text>
      </Text>
    );
  }

  override list(
    ordered: boolean,
    li: ReactNode[],
    listStyle?: ViewStyle,
    textStyle?: TextStyle,
    startIndex = 1,
  ): ReactNode {
    const digits = String(startIndex + li.length - 1).length;
    return (
      <View key={this.getKey()} style={[listStyle, { gap: space(1) }]}>
        {li.map((item, index) => (
          <View key={index} style={{ flexDirection: "row" }}>
            <View
              style={{
                width: ordered ? 10 + digits * 9 : 18,
                height: this.lineHeight,
                justifyContent: "center",
              }}
            >
              {ordered ? (
                <Text style={[textStyle, { color: this.marker, fontVariant: ["tabular-nums"] }]}>
                  {startIndex + index}.
                </Text>
              ) : (
                <View
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 2.5,
                    marginLeft: 3,
                    backgroundColor: this.marker,
                  }}
                />
              )}
            </View>
            <View style={{ flex: 1 }}>{item}</View>
          </View>
        ))}
      </View>
    );
  }
}

/**
 * A teammate's reply, in Markdown, in the app's type. `muted` is for progress notes and thinking,
 * smaller and grey, as on the web.
 */
export function Markdown({ text, tone = "default" }: { text: string; tone?: "default" | "muted" }) {
  const colors = useColors();
  const scheme = useColorScheme();
  const ink = tone === "muted" ? colors.mutedForeground : colors.foreground;
  const styles = useMemo<MarkedStyles>(() => {
    const body = {
      fontFamily: fonts.sans,
      fontSize: tone === "muted" ? 14 : 15,
      lineHeight: tone === "muted" ? 20 : 22,
      color: ink,
    };
    const heading = { fontFamily: fonts.heading, fontWeight: "600" as const, color: ink };
    return {
      text: body,
      paragraph: { marginVertical: space(1), padding: 0 },
      strong: { ...body, fontWeight: "600" },
      em: { ...body, fontStyle: "italic" },
      link: { ...body, fontStyle: "normal", textDecorationLine: "underline" },
      h1: { ...heading, fontSize: 20, lineHeight: 26, marginTop: space(2) },
      h2: { ...heading, fontSize: 18, lineHeight: 24, marginTop: space(2) },
      h3: { ...heading, fontSize: 16, lineHeight: 22, marginTop: space(1) },
      h4: { ...heading, fontSize: 15, lineHeight: 22 },
      codespan: {
        fontFamily: fonts.mono,
        fontStyle: "normal",
        // 0.9em of the body, on the body's line height.
        fontSize: tone === "muted" ? 12.5 : 13.5,
        lineHeight: tone === "muted" ? 20 : 22,
        color: ink,
        // 6% of the text color in light, 10% in dark: a tint, not a slab.
        backgroundColor: `${ink}${scheme === "dark" ? "1A" : "0F"}`,
      },
      code: {
        backgroundColor: colors.muted,
        borderRadius: radius.lg,
        padding: space(3),
        marginVertical: space(1),
      },
      codeText: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 19, color: colors.foreground },
      blockquote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: space(3) },
      hr: { backgroundColor: colors.border, height: 1, marginVertical: space(3) },
      li: body,
      list: { marginVertical: space(1) },
      tableCell: { padding: space(2) },
      tableRow: { borderColor: colors.border },
      table: { borderColor: colors.border, borderWidth: 1, borderRadius: radius.md },
    };
  }, [colors, ink, tone, scheme]);
  const lineHeight = tone === "muted" ? 20 : 22;
  const renderer = useMemo(() => new AppRenderer(ink, lineHeight), [ink, lineHeight]);
  const elements = useMarkdown(text, {
    colorScheme: scheme ?? undefined,
    styles,
    renderer,
    theme: {
      colors: {
        text: ink,
        link: ink,
        border: colors.border,
        code: colors.muted,
      },
    },
  });
  return (
    <View>
      {elements.map((element, index) => (
        <Fragment key={index}>{element}</Fragment>
      ))}
    </View>
  );
}
