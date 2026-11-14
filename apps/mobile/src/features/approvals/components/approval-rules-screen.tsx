import type { ApprovalRule } from "@open-bot/api";
import { accountTool, type RuleKind } from "@open-bot/domain";
import { safe } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { BotAvatar } from "@/features/teammates/components/bot-avatar";
import { Separator } from "@/components/list-row";
import { Card } from "@/components/section";
import { Empty, LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useApprovalRules } from "@/features/approvals/hooks";
import { useTeammates } from "@/features/teammates/hooks";
import { queryKeys } from "@/lib/query";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { space, useColors } from "@/theme";

const KIND: Record<RuleKind, string> = {
  command: "Commands starting with",
  file_change: "Changing files",
  action: "Doing",
  account_write: "On your accounts",
};

/** What each teammate may do without asking, from "Always allow". Remove one to be asked again. */
export default function ApprovalRules() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const queryClient = useQueryClient();
  const rules = useApprovalRules();
  const { data: bots = [] } = useTeammates();
  const [removing, setRemoving] = useState<string | null>(null);

  const sections = useMemo(() => {
    const byBot = new Map<string, ApprovalRule[]>();
    for (const rule of rules.data ?? [])
      byBot.set(rule.teammateId, [...(byBot.get(rule.teammateId) ?? []), rule]);
    return [...byBot].map(([botId, data]) => ({
      botId,
      bot: bots.find((candidate) => candidate.id === botId),
      data,
    }));
  }, [rules.data, bots]);

  const remove = (rule: ApprovalRule, botName: string) =>
    Alert.alert("Ask about this again?", `${botName} will ask you before doing it next time.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setRemoving(rule.id);
          const result = await safe(api.approvals.removeRule({ ruleId: rule.id }));
          setRemoving(null);
          if (result.error) Alert.alert("Couldn't remove it", errorMessage(result.error));
          void queryClient.invalidateQueries({ queryKey: queryKeys.approvalRules });
        },
      },
    ]);

  if (rules.isLoading) return <Loading />;
  if (rules.error && !rules.data)
    return <LoadError error={rules.error} onRetry={() => void rules.refetch()} />;
  if (sections.length === 0)
    return (
      <Empty
        icon={<ShieldCheck size={28} color={colors.mutedForeground} />}
        title="Nothing allowed yet"
        body="Use “Always allow” on an approval, and the teammate stops asking about things like it."
      />
    );
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottom }]}>
        <Text variant="small" muted style={styles.intro}>
          Teammates do these without asking. Remove one to be asked again.
        </Text>
        {sections.map((section) => {
          const botName = section.bot?.name ?? "Former teammate";
          return (
            <View key={section.botId} style={{ gap: space(2.5) }}>
              <View style={styles.head}>
                <BotAvatar
                  name={section.bot?.name ?? "?"}
                  color={section.bot?.color ?? colors.mutedForeground}
                  emoji={section.bot?.emoji}
                  size="sm"
                />
                <Text variant="label">{botName}</Text>
              </View>
              <Card>
                {section.data.map((rule, index) => (
                  <View key={rule.id}>
                    {index > 0 && <Separator inset={space(4)} />}
                    <View style={styles.row} testID="approval-rule">
                      <View style={{ flex: 1, gap: space(1) }}>
                        <Text variant="caption" muted>
                          {KIND[rule.kind]}
                        </Text>
                        {rule.kind !== "file_change" && (
                          <Text variant={rule.kind === "command" ? "mono" : "label"} selectable>
                            {rule.kind === "account_write"
                              ? (accountTool(rule.pattern)?.label ?? rule.pattern)
                              : rule.pattern}
                          </Text>
                        )}
                      </View>
                      {removing === rule.id ? (
                        <View style={styles.remove}>
                          <ActivityIndicator size="small" color={colors.mutedForeground} />
                        </View>
                      ) : (
                        <Pressable
                          onPress={() => remove(rule, section.bot?.name ?? "This teammate")}
                          android_ripple={{ color: colors.muted, borderless: true, radius: 22 }}
                          style={styles.remove}
                          accessibilityRole="button"
                          accessibilityLabel="Remove"
                          testID="remove-rule"
                        >
                          <X size={18} color={colors.mutedForeground} />
                        </Pressable>
                      )}
                    </View>
                  </View>
                ))}
              </Card>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(6) },
  intro: { paddingHorizontal: space(1) },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    paddingHorizontal: space(1),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingLeft: space(4),
    paddingRight: space(1),
    paddingVertical: space(2),
    minHeight: 64,
  },
  remove: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
});
