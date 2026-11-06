import {
  eventChangeLabel,
  eventTime,
  previewNote,
  type AccountActionPreview,
} from "@open-bot/shared";
import * as WebBrowser from "expo-web-browser";
import {
  CalendarDays,
  ExternalLink,
  Mail,
  MapPin,
  NotebookText,
  TriangleAlert,
  Users,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { Text } from "@/components/text";
import { radius, space, useColors } from "@/theme";

/** The icon an approval for this action shows, as on the web. */
export function previewIcon(preview: AccountActionPreview | null | undefined) {
  if (!preview) return null;
  return preview.type === "email" ? Mail : preview.type === "event" ? CalendarDays : NotebookText;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="small" muted style={styles.fieldLabel}>
        {label}
      </Text>
      <Text variant="small" selectable style={{ flex: 1 }}>
        {children}
      </Text>
    </View>
  );
}

function Line({ icon, children }: { icon: ReactNode; children: string }) {
  return (
    <View style={styles.line}>
      {icon}
      <Text variant="small" selectable style={{ flex: 1 }}>
        {children}
      </Text>
    </View>
  );
}

/**
 * Exactly what an action on one of your accounts will do, for its approval: the email as it
 * will be sent, the event as guests will see it, or the change to make.
 */
export function ActionPreview({
  preview,
  compact,
  style,
}: {
  preview: AccountActionPreview;
  /** In a chat card: the body is cut short; the approval screen shows all of it. */
  compact?: boolean;
  style?: ViewStyle;
}) {
  const colors = useColors();
  const box = [styles.box, { backgroundColor: colors.surface, borderColor: colors.border }, style];
  const note = previewNote(preview);
  const noteView = note ? (
    <View style={styles.line}>
      <TriangleAlert size={13} color={colors.attentionInk} style={{ marginTop: 2.5 }} />
      <Text variant="small" style={{ flex: 1, color: colors.attentionInk }}>
        {note}
      </Text>
    </View>
  ) : null;

  if (preview.type === "email")
    return (
      <View style={box} testID="action-preview">
        <View style={{ gap: space(1) }}>
          <Field label="From">{preview.account}</Field>
          <Field label="To">{preview.to.join(", ") || "Nobody yet"}</Field>
          {preview.cc.length > 0 && <Field label="Cc">{preview.cc.join(", ")}</Field>}
          {preview.bcc.length > 0 && <Field label="Bcc">{preview.bcc.join(", ")}</Field>}
          <Field label="Subject">{preview.subject || "(no subject)"}</Field>
        </View>
        {preview.inReplyTo && (
          <Text variant="caption" muted>
            A reply in “{preview.inReplyTo}”
          </Text>
        )}
        <View style={[styles.body, { borderTopColor: colors.border }]}>
          <Text selectable numberOfLines={compact ? 8 : undefined} style={styles.bodyText}>
            {preview.body || "(empty)"}
          </Text>
        </View>
      </View>
    );

  if (preview.type === "event") {
    const time = eventTime(preview);
    return (
      <View style={box} testID="action-preview">
        <View style={{ gap: 2 }}>
          <Text variant="caption" muted>
            {eventChangeLabel(preview)}
          </Text>
          <Text
            variant="label"
            selectable
            style={
              preview.change === "delete"
                ? { textDecorationLine: "line-through", color: colors.mutedForeground }
                : undefined
            }
          >
            {preview.title || "(no title)"}
          </Text>
          {time && (
            <Text variant="small" selectable>
              {time}
            </Text>
          )}
        </View>
        {preview.location && (
          <Line icon={<MapPin size={14} color={colors.mutedForeground} style={styles.lineIcon} />}>
            {preview.location}
          </Line>
        )}
        {preview.guests.length > 0 && (
          <Line icon={<Users size={14} color={colors.mutedForeground} style={styles.lineIcon} />}>
            {preview.guests.join(", ")}
          </Line>
        )}
        {noteView}
      </View>
    );
  }

  const url = preview.url;
  return (
    <View style={box} testID="action-preview">
      <View style={{ gap: 2 }}>
        <Text variant="caption" muted>
          {preview.action} · {preview.account}
        </Text>
        {url ? (
          <Pressable
            onPress={() => void WebBrowser.openBrowserAsync(url)}
            accessibilityRole="link"
            hitSlop={6}
            style={styles.link}
          >
            <Text variant="label" style={{ flexShrink: 1, textDecorationLine: "underline" }}>
              {preview.target}
            </Text>
            <ExternalLink size={13} color={colors.mutedForeground} />
          </Pressable>
        ) : (
          <Text variant="label" selectable>
            {preview.target}
          </Text>
        )}
      </View>
      {preview.detail ? (
        <Text variant="small" selectable numberOfLines={compact ? 8 : undefined}>
          {preview.detail}
        </Text>
      ) : null}
      {noteView}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: radius.xl, padding: space(3.5), gap: space(2.5) },
  field: { flexDirection: "row", gap: space(3) },
  fieldLabel: { width: 56 },
  body: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space(2.5) },
  bodyText: { fontSize: 14, lineHeight: 21 },
  line: { flexDirection: "row", gap: space(1.5) },
  lineIcon: { marginTop: 2 },
  link: { flexDirection: "row", alignItems: "center", gap: space(1), alignSelf: "flex-start" },
});
