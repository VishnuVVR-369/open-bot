import type { TeammateSummary } from "@open-bot/api";
import { router, useNavigation } from "expo-router";
import { Archive, ChevronRight, Copy, Crown } from "lucide-react-native";
import { type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { ListRow } from "@/components/list-row";
import { Card, Section } from "@/components/section";
import { Text } from "@/components/text";
import { useOnline } from "@/lib/network";
import { space, useColors } from "@/theme";
import { mix } from "@/theme/mix";
import { confirmArchive, confirmMakeLead } from "../actions";
import { useArchiving } from "../archiving";

/**
 * Who leads, and the teammate's own lifecycle: make them the lead, duplicate them, or archive
 * them, as the web's profile has it. They need the phone online.
 */
export function TeammateManage({
  teammate,
  team,
}: {
  teammate: TeammateSummary;
  team: readonly TeammateSummary[];
}) {
  const colors = useColors();
  const online = useOnline();
  const navigation = useNavigation();
  const archiving = useArchiving(teammate.id);
  const lead = team.find((entry) => entry.isLead);
  const { name } = teammate;
  return (
    <Section title="Manage">
      <Card>
        {teammate.isLead ? (
          // Already the lead: said, not offered, and not faded like an unavailable action.
          <View style={styles.row} testID="teammate-is-lead">
            <RowIcon icon={<Crown size={18} color={colors.foreground} />} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="label">{`${name} is the lead`}</Text>
              <Text variant="small" muted>
                {`${name} answers group messages that don't mention anyone, and hands work to others.`}
              </Text>
            </View>
          </View>
        ) : (
          <ListRow
            leading={<RowIcon icon={<Crown size={18} color={colors.foreground} />} />}
            title={`Make ${name} the lead`}
            subtitle={
              lead
                ? `${lead.name} leads now. The lead answers group messages that don't mention anyone.`
                : "Nobody leads now. The lead answers group messages that don't mention anyone."
            }
            subtitleLines={4}
            onPress={() => confirmMakeLead(teammate, lead)}
            disabled={!online || archiving}
            testID="teammate-make-lead"
          />
        )}
        <Divider />
        <ListRow
          leading={<RowIcon icon={<Copy size={18} color={colors.foreground} />} />}
          title={`Duplicate ${name}`}
          subtitle="A new teammate set up the same way, with its automations off."
          subtitleLines={4}
          aside={<ChevronRight size={18} color={colors.mutedForeground} />}
          onPress={() => router.push(`/teammates/${teammate.id}/duplicate`)}
          disabled={!online || archiving}
          testID="teammate-duplicate-open"
        />
        <Divider />
        <ListRow
          leading={
            <RowIcon tone="destructive" icon={<Archive size={18} color={colors.destructive} />} />
          }
          title={`Archive ${name}`}
          titleStyle={{ color: colors.destructive }}
          subtitle="Stops their work and automations. Their files stay on the computer."
          subtitleLines={4}
          aside={archiving ? <ActivityIndicator size="small" color={colors.destructive} /> : null}
          onPress={() =>
            confirmArchive(teammate, {
              // Its chats are archived too, so back to Home rather than to one of them; only from
              // the profile, though: wherever you went meanwhile, you stay.
              onDone: (archived) => {
                if (archived && navigation.isFocused()) router.dismissTo("/");
              },
            })
          }
          disabled={!online || archiving}
          testID="teammate-archive"
        />
      </Card>
      {!online && (
        <Text variant="caption" muted style={styles.inset}>
          You're offline. You can do these once you're back.
        </Text>
      )}
    </Section>
  );
}

function Divider() {
  const colors = useColors();
  return <View style={[styles.divider, { backgroundColor: colors.border }]} />;
}

function RowIcon({ icon, tone }: { icon: ReactNode; tone?: "destructive" }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.icon,
        {
          backgroundColor:
            tone === "destructive" ? mix(colors.destructive, colors.surface, 0.1) : colors.subtle,
        },
      ]}
    >
      {icon}
    </View>
  );
}

const styles = StyleSheet.create({
  inset: { paddingHorizontal: space(1) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 64,
  },
  divider: { height: StyleSheet.hairlineWidth },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
