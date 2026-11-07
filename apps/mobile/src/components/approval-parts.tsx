import type { ApprovalView, BotSummary } from "@open-bot/api";
import type { ApprovalRisk } from "@open-bot/shared";
import { Check, CircleDashed, Clock, OctagonAlert, TriangleAlert, X } from "lucide-react-native";
import type { ReactNode } from "react";
import { StyleSheet, View, type TextProps } from "react-native";
import { ApprovalIcon } from "@/components/approval-icon";
import { BotAvatar, type AvatarSize, type BotActivity } from "@/components/bot-avatar";
import { Text, type TextVariant } from "@/components/text";
import { detailRows, titleParts } from "@/lib/approval-text";
import { fonts, radius, space, useColors } from "@/theme";
import { mix } from "@/theme/mix";

/** Dark text on an amber fill, the one place a fixed ink is needed for contrast. */
export const ON_ATTENTION = "#1A1200";

/** Something in the corner of an avatar: what kind of thing it's about. */
export function AvatarBadge({
  children,
  badge,
  tint,
  ink,
}: {
  children: ReactNode;
  badge: ReactNode;
  /** The badge's fill. */
  tint: string;
  /** The ring around the badge, matching what's behind the avatar. */
  ink: string;
}) {
  return (
    <View>
      {children}
      <View style={[styles.badge, { backgroundColor: tint, borderColor: ink }]}>{badge}</View>
    </View>
  );
}

/** A teammate's face with what they asked to do in its corner. */
export function ApprovalAvatar({
  bot,
  approval,
  pending,
  size = "lg",
  activity = "idle",
  behind,
}: {
  bot: Pick<BotSummary, "name" | "color" | "emoji"> | undefined;
  approval: Pick<ApprovalView, "kind" | "title" | "preview">;
  pending: boolean;
  size?: AvatarSize;
  activity?: BotActivity;
  /** What's behind the avatar, so the badge looks cut out of it. */
  behind: string;
}) {
  const colors = useColors();
  return (
    <AvatarBadge
      tint={pending ? colors.attention : colors.subtle}
      ink={behind}
      badge={
        <ApprovalIcon
          kind={approval.kind}
          title={approval.title}
          preview={approval.preview}
          size={11}
          color={pending ? ON_ATTENTION : colors.foreground}
        />
      }
    >
      <BotAvatar
        name={bot?.name ?? "?"}
        color={bot?.color ?? colors.mutedForeground}
        emoji={bot?.emoji}
        size={size}
        activity={activity}
      />
    </AvatarBadge>
  );
}

/** How a request ended (or that it's waiting), with an icon and a word, never color alone. */
export function ApprovalStatusChip({
  status,
  size = "md",
}: {
  status: ApprovalView["status"];
  /** `sm` sits at the end of a list row, leaving the title room. */
  size?: "sm" | "md";
}) {
  const colors = useColors();
  const [Icon, signal, label] =
    status === "approved"
      ? [Check, colors.done, "Approved"]
      : status === "denied"
        ? [X, colors.destructive, "Denied"]
        : status === "expired"
          ? [CircleDashed, colors.mutedForeground, "Expired"]
          : [Clock, colors.attention, "Waiting"];
  const ink =
    status === "expired"
      ? colors.mutedForeground
      : status === "pending"
        ? colors.attentionInk
        : mix(signal, colors.foreground, 0.75);
  return (
    <View
      style={[
        styles.chip,
        size === "sm" && styles.chipSmall,
        { backgroundColor: mix(signal, colors.surface, 0.12) },
      ]}
      accessible
      accessibilityLabel={label}
    >
      <Icon size={size === "sm" ? 11 : 13} color={ink} strokeWidth={2.5} />
      <Text
        variant="caption"
        style={[
          { color: ink, fontWeight: "600" },
          size === "sm" && { fontSize: 11, lineHeight: 14 },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

/** An approval's title, with the code it quotes in monospace instead of between backticks. */
export function ApprovalTitle({
  title,
  variant = "label",
  muted,
  ...props
}: TextProps & { title: string; variant?: TextVariant; muted?: boolean }) {
  const colors = useColors();
  return (
    <Text variant={variant} muted={muted} {...props}>
      {titleParts(title).map((part, index) =>
        part.code ? (
          <Text
            key={index}
            variant={variant}
            style={{
              fontFamily: fonts.mono,
              fontWeight: "400",
              // Mono reads a little bigger than the sans beside it, so it runs a size smaller.
              fontSize:
                variant === "title"
                  ? 20
                  : variant === "heading"
                    ? 16
                    : variant === "small" || variant === "caption"
                      ? 12
                      : 14,
              color: muted ? colors.mutedForeground : colors.foreground,
            }}
          >
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}

/**
 * A detail written as "Label: value" lines, as a summary and labeled rows, or null when the
 * detail isn't shaped that way (the caller shows it as written).
 */
export function DetailRows({ detail, background }: { detail: string; background?: string }) {
  const colors = useColors();
  const parsed = detailRows(detail);
  if (!parsed) return null;
  return (
    <View style={{ gap: space(2.5) }}>
      {parsed.summary && (
        <Text variant="small" selectable style={{ fontSize: 14, lineHeight: 20 }}>
          {parsed.summary}
        </Text>
      )}
      <View
        style={[
          styles.rows,
          { backgroundColor: background ?? colors.surface, borderColor: colors.border },
        ]}
      >
        {parsed.rows.map((row, index) => (
          <View
            key={`${row.label}-${index}`}
            style={[
              styles.detailRow,
              index > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.border,
              },
            ]}
          >
            <Text variant="caption" muted style={styles.detailLabel}>
              {row.label}
            </Text>
            <Text variant="small" selectable style={{ flex: 1, fontSize: 14, lineHeight: 20 }}>
              {row.value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A second-look note: red for what can't be undone, amber for money and mail. */
export function RiskNote({ risk }: { risk: ApprovalRisk }) {
  const colors = useColors();
  const signal = risk.tone === "destructive" ? colors.destructive : colors.attention;
  const ink = risk.tone === "destructive" ? colors.destructive : colors.attentionInk;
  const Icon = risk.tone === "destructive" ? OctagonAlert : TriangleAlert;
  return (
    <View
      style={[
        styles.risk,
        {
          backgroundColor: mix(signal, colors.surface, 0.08),
          borderColor: mix(signal, colors.surface, 0.3),
        },
      ]}
      accessibilityRole="alert"
    >
      <Icon size={18} color={ink} />
      <Text variant="small" style={{ flex: 1, color: colors.foreground }}>
        {risk.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  rows: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  detailRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(3),
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
  },
  // Sized for the longest usual label ("Card", "Back", "Route") so values line up.
  detailLabel: { width: 52, fontSize: 13, lineHeight: 20 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1),
    paddingHorizontal: space(2),
    paddingVertical: space(1),
    borderRadius: radius.full,
  },
  chipSmall: { gap: 3, paddingHorizontal: space(1.5), paddingVertical: 2 },
  risk: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: space(3.5),
    paddingVertical: space(3),
  },
});
