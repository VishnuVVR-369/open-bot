import type { VaultItemView } from "@open-bot/api";
import {
  addVaultItemLabel,
  budgetSummary,
  VAULT_COPY,
  VAULT_PROMISES,
  type VaultKind,
} from "@open-bot/domain";
import { router, Stack } from "expo-router";
import {
  ChevronRight,
  CreditCard,
  EyeOff,
  Globe,
  KeyRound,
  Lock,
  Plus,
  Wallet,
  type LucideIcon,
} from "lucide-react-native";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Card, Section } from "@/components/section";
import { LoadError, Loading } from "@/components/states";
import { Text } from "@/components/text";
import { ConnectionNotice } from "@/features/computer/components/connection-notice";
import { TeammateAvatar } from "@/features/teammates/components/teammate-avatar";
import { useTeammates } from "@/features/teammates/hooks";
import { haptics } from "@/lib/haptics";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { space, useColors } from "@/theme";
import { useAllSpending, useVaultItems } from "../hooks";
import { budgetHref, newVaultItemHref, vaultItemHref, vaultSections } from "../vault";
import { VaultGate } from "./vault-gate";
import { VaultItemRow } from "./vault-item-row";

const PROMISE_ICONS: Record<(typeof VAULT_PROMISES)[number]["key"], LucideIcon> = {
  "never-seen": EyeOff,
  "own-site": Globe,
  budget: Wallet,
  encrypted: Lock,
};

/** Logins, cards and budgets, behind your fingerprint. */
export default function VaultScreen() {
  return (
    <VaultGate>
      <Vault />
    </VaultGate>
  );
}

function Vault() {
  const bottom = useSafeBottom();
  const colors = useColors();
  const items = useVaultItems();
  const teammates = useTeammates();
  const all = teammates.data ?? [];
  const spending = useAllSpending(all.map((teammate) => teammate.id));
  const { refreshing, onRefresh } = usePullToRefresh(() =>
    Promise.all([
      items.refetch(),
      teammates.refetch(),
      ...spending.map((entry) => entry.refetch()),
    ]),
  );

  const body = items.isLoading ? (
    <Loading />
  ) : !items.data ? (
    <LoadError
      title="Couldn't open the vault"
      error={items.error}
      onRetry={() => void items.refetch()}
    />
  ) : null;
  const { logins, cards } = vaultSections(items.data ?? []);

  return (
    <View style={{ flex: 1 }} testID="vault-screen">
      <Stack.Screen options={{ title: "Vault" }} />
      {body ?? (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottom }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              colors={[colors.foreground]}
              progressBackgroundColor={colors.surface}
            />
          }
        >
          <ConnectionNotice />
          <ItemSection
            kind="login"
            title="Logins"
            about={VAULT_COPY.loginsAbout}
            items={logins}
            teammates={all}
          />
          <ItemSection
            kind="card"
            title="Cards"
            about={VAULT_COPY.cardsAbout}
            items={cards}
            teammates={all}
          />
          {all.length > 0 && (
            <Section title="Budgets">
              <Text variant="small" muted style={styles.inset}>
                What each teammate may spend from these cards each month.
              </Text>
              <Card>
                {all.map((teammate, index) => {
                  const data = spending[index]?.data;
                  return (
                    <Pressable
                      key={teammate.id}
                      onPress={() => {
                        haptics.tap();
                        router.push(budgetHref(teammate.id));
                      }}
                      accessibilityRole="button"
                      android_ripple={{ color: colors.muted }}
                      style={[
                        styles.row,
                        index > 0 && {
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderTopColor: colors.border,
                        },
                      ]}
                      testID={`vault-budget-${teammate.id}`}
                    >
                      <TeammateAvatar {...teammate} size="md" />
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text variant="label" numberOfLines={1}>
                          {teammate.name}
                        </Text>
                        <Text variant="small" muted numberOfLines={2}>
                          {data ? budgetSummary(data) : " "}
                        </Text>
                      </View>
                      <ChevronRight size={18} color={colors.mutedForeground} />
                    </Pressable>
                  );
                })}
              </Card>
            </Section>
          )}
          <View style={[styles.promises, { borderTopColor: colors.border }]}>
            {VAULT_PROMISES.map(({ key, title, text }) => {
              const Icon = PROMISE_ICONS[key];
              return (
                <View key={key} style={styles.promise}>
                  <Icon size={16} color={colors.mutedForeground} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="label" style={{ fontSize: 14 }}>
                      {title}
                    </Text>
                    <Text variant="small" muted>
                      {text}
                    </Text>
                  </View>
                </View>
              );
            })}
            <Text variant="caption" muted>
              {VAULT_COPY.screenshots}
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function ItemSection({
  kind,
  title,
  about,
  items,
  teammates,
}: {
  kind: VaultKind;
  title: string;
  about: string;
  items: VaultItemView[];
  teammates: readonly { id: string; name: string }[];
}) {
  const colors = useColors();
  const add = () => {
    haptics.tap();
    router.push(newVaultItemHref(kind));
  };
  return (
    <Section
      title={title}
      action={
        items.length > 0 ? (
          <Pressable
            onPress={add}
            hitSlop={12}
            accessibilityRole="button"
            style={styles.add}
            testID={`vault-add-${kind}`}
          >
            <Plus size={16} color={colors.foreground} />
            <Text variant="small" style={{ fontWeight: "600" }}>
              {addVaultItemLabel(kind)}
            </Text>
          </Pressable>
        ) : undefined
      }
    >
      <Text variant="small" muted style={styles.inset}>
        {about}
      </Text>
      {items.length > 0 ? (
        <Card>
          {items.map((item, index) => (
            <VaultItemRow
              key={item.id}
              item={item}
              teammates={teammates}
              first={index === 0}
              onPress={() => router.push(vaultItemHref(item.id))}
            />
          ))}
        </Card>
      ) : (
        <Pressable
          onPress={add}
          accessibilityRole="button"
          android_ripple={{ color: colors.muted }}
          style={[styles.empty, { borderColor: colors.input }]}
          testID={`vault-add-${kind}`}
        >
          <View style={[styles.icon, { backgroundColor: colors.subtle }]}>
            {kind === "login" ? (
              <KeyRound size={18} color={colors.mutedForeground} />
            ) : (
              <CreditCard size={18} color={colors.mutedForeground} />
            )}
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label">{addVaultItemLabel(kind)}</Text>
            <Text variant="small" muted>
              {kind === "login" ? VAULT_COPY.noLogins : VAULT_COPY.noCards}
            </Text>
          </View>
        </Pressable>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(7) },
  inset: { paddingHorizontal: space(1), marginTop: -space(1) },
  add: { flexDirection: "row", alignItems: "center", gap: space(1) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    minHeight: 64,
  },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  empty: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 18,
    padding: space(4),
    overflow: "hidden",
  },
  promises: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space(6), gap: space(4) },
  promise: { flexDirection: "row", gap: space(3) },
});
