import type { SpendingView } from "@open-bot/api";
import {
  budgetCopy,
  budgetForm,
  budgetFormChanged,
  budgetInput,
  budgetProblem,
  budgetUse,
  formatMoney,
  mayUse,
  moneyInput,
  rebaseBudgetForm,
  spendingMonth,
  type BudgetForm,
} from "@open-bot/domain";
import { safe } from "@orpc/client";
import { router, Stack, useLocalSearchParams, usePreventRemove } from "expo-router";
import { CloudOff, CreditCard, Users } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Card, Section } from "@/components/section";
import { LoadError, Loading, NotFound } from "@/components/states";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { Toggle } from "@/components/toggle";
import { useTeammates } from "@/features/teammates/hooks";
import { api } from "@/lib/api";
import { errorMessage, isGone, isStateConflict } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useOnline } from "@/lib/network";
import { queryClient, queryKeys } from "@/lib/query";
import { useSafeBottom } from "@/lib/use-safe-bottom";
import { space, useColors } from "@/theme";
import { useSpending, useVaultItems, vaultLock } from "../hooks";
import { newVaultItemHref } from "../vault";
import { PurchaseRow } from "./purchase-row";
import { useVaultOpen, VaultGate } from "./vault-gate";

/** A teammate's monthly budget and purchases, behind your fingerprint. */
export default function BudgetScreen() {
  return (
    <VaultGate>
      <Budget />
    </VaultGate>
  );
}

function Budget() {
  const { teammateId } = useLocalSearchParams<{ teammateId: string }>();
  const teammates = useTeammates();
  const spending = useSpending(teammateId);
  const teammate = teammates.data?.find((entry) => entry.id === teammateId);
  if (teammates.isLoading || spending.isLoading) return <Loading />;
  if (!teammate || (spending.error && isGone(spending.error)))
    return (
      <NotFound
        icon={Users}
        title="This teammate is unavailable"
        body="They may have been removed, or the link may be wrong."
        action="Go back"
        onAction={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      />
    );
  if (!spending.data)
    return (
      <LoadError
        title="Couldn't load the budget"
        error={spending.error}
        onRetry={() => void spending.refetch()}
      />
    );
  return <BudgetEditor teammateId={teammate.id} name={teammate.name} data={spending.data} />;
}

/**
 * The budget as the web's Spending tab sets it. Saving names the budget you saw, so one changed
 * on the web meanwhile is refused and shown instead of overwritten; what you haven't touched
 * follows it. Leaving with changes asks first, and nothing is sent offline.
 */
function BudgetEditor({
  teammateId,
  name,
  data,
}: {
  teammateId: string;
  name: string;
  data: SpendingView;
}) {
  const colors = useColors();
  const bottom = useSafeBottom();
  const online = useOnline();
  const open = useVaultOpen();
  const { data: vault } = useVaultItems();
  const copy = budgetCopy(name);
  const [draft, setDraft] = useState(() => {
    const start = budgetForm(data);
    return { start, form: start };
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const { form } = draft;
  const changed = budgetFormChanged(draft.start, form);
  const invalid = budgetProblem(form);
  const editable = open && !busy;

  // The saved budget changed (here, on the web, or by a refresh after a conflict): what you haven't
  // touched follows it. A purchase meanwhile changes only what's spent, and leaves the form alone.
  const { budgetCents, autoApproveCents } = data;
  useEffect(() => {
    if (busy) return;
    setDraft((current) => rebaseBudgetForm(current, budgetForm({ budgetCents, autoApproveCents })));
  }, [budgetCents, autoApproveCents, busy]);

  usePreventRemove(changed && !discarded, ({ repeat }) =>
    Alert.alert("Discard your changes?", `${name}'s budget isn't saved.`, [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          setDiscarded(true);
          repeat();
        },
      },
    ]),
  );

  const set = (patch: Partial<BudgetForm>) => {
    if (!editable) return;
    setProblem(null);
    setConflict(false);
    setDraft((current) => ({ ...current, form: { ...current.form, ...patch } }));
  };

  async function save() {
    if (invalid) {
      setProblem(invalid);
      haptics.warning();
      return;
    }
    if (!vaultLock.isOpen()) return;
    setBusy(true);
    setProblem(null);
    const result = await safe(
      api.teammates.setBudget({
        teammateId,
        ...budgetInput(form),
        expected: { budgetCents, autoApproveCents },
      }),
    );
    await queryClient.invalidateQueries({ queryKey: queryKeys.spending(teammateId) });
    setBusy(false);
    if (result.error) {
      haptics.error();
      if (isStateConflict(result.error)) setConflict(true);
      else setProblem(errorMessage(result.error, "Couldn't save the budget."));
      return;
    }
    haptics.success();
    setDraft((current) => ({ start: current.form, form: current.form }));
  }

  const cards = (vault ?? []).filter((item) => item.kind === "card" && mayUse(item, teammateId));
  const use = budgetUse(data);
  const tone = { done: colors.done, attention: colors.attention, destructive: colors.destructive }[
    use.tone
  ];
  const dollars = (
    <Text muted style={styles.dollar}>
      $
    </Text>
  );

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.content, { paddingBottom: bottom }]}
      testID="budget-screen"
    >
      <Stack.Screen options={{ title: `${name}'s budget` }} />
      <Card>
        <Pressable
          onPress={() => {
            haptics.tap();
            set({ enabled: !form.enabled });
          }}
          disabled={!editable}
          accessibilityRole="switch"
          accessibilityState={{ checked: form.enabled, disabled: !editable }}
          accessibilityLabel={copy.canPay}
          style={styles.toggle}
          testID="budget-enabled"
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label">{copy.canPay}</Text>
            <Text variant="small" muted>
              {copy.canPayHint}
            </Text>
          </View>
          <Toggle
            value={form.enabled}
            disabled={!editable}
            importantForAccessibility="no-hide-descendants"
          />
        </Pressable>
      </Card>
      {form.enabled && (
        <View style={{ gap: space(4) }}>
          <MoneyField
            label={copy.monthly}
            value={form.budget}
            onChange={(budget) => set({ budget })}
            editable={editable}
            leading={dollars}
            testID="budget-amount"
          />
          <MoneyField
            label={copy.autoApprove}
            hint={copy.autoApproveHint}
            value={form.autoApprove}
            onChange={(autoApprove) => set({ autoApprove })}
            editable={editable}
            leading={dollars}
            testID="budget-auto-approve"
          />
        </View>
      )}
      {form.enabled && cards.length === 0 && (
        <Pressable
          onPress={() => router.push(newVaultItemHref("card"))}
          accessibilityRole="button"
          style={[styles.note, { backgroundColor: colors.subtle }]}
          testID="budget-no-card"
        >
          <CreditCard size={16} color={colors.mutedForeground} />
          <Text variant="small" muted style={{ flex: 1 }}>
            {copy.noCard} <Text variant="small">Add one in the vault.</Text>
          </Text>
        </Pressable>
      )}
      {(changed || conflict || problem) && (
        <View style={{ gap: space(2.5) }}>
          {!online ? (
            <View style={styles.offline}>
              <CloudOff size={14} color={colors.mutedForeground} />
              <Text variant="caption" muted style={{ flex: 1 }}>
                You're offline. Your changes stay here until you're back.
              </Text>
            </View>
          ) : conflict ? (
            <Text variant="small" style={{ color: colors.attentionInk }} testID="budget-conflict">
              The budget changed since you opened it. Check it, then save again.
            </Text>
          ) : problem || (changed && invalid) ? (
            <Text variant="small" style={{ color: colors.destructive }} testID="budget-problem">
              {problem ?? invalid}
            </Text>
          ) : null}
          <Button
            title="Save budget"
            onPress={() => void save()}
            disabled={!online || !editable || !changed || Boolean(invalid)}
            busy={busy}
            testID="budget-save"
          />
        </View>
      )}

      {data.budgetCents !== null && (
        <View style={styles.spent} testID="budget-spent">
          <View style={styles.spentLine}>
            <Text variant="label">Spent in {spendingMonth()}</Text>
            <Text variant="label">
              {formatMoney(data.spentCents)}
              <Text muted> of {formatMoney(data.budgetCents)}</Text>
            </Text>
          </View>
          <View
            style={[styles.track, { backgroundColor: colors.muted }]}
            accessibilityRole="progressbar"
            accessibilityLabel={`Spent in ${spendingMonth()}`}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(use.share * 100) }}
          >
            <View style={[styles.bar, { width: `${use.share * 100}%`, backgroundColor: tone }]} />
          </View>
        </View>
      )}

      <Section title="Purchases">
        <Text variant="small" muted style={styles.inset}>
          {data.purchases.length > 0 ? copy.purchases : copy.noPurchases}
        </Text>
        {data.purchases.length > 0 && (
          <Card>
            {data.purchases.map((purchase, index) => (
              <PurchaseRow key={purchase.id} purchase={purchase} first={index === 0} />
            ))}
          </Card>
        )}
      </Section>
    </ScrollView>
  );
}

function MoneyField({
  label,
  hint,
  value,
  onChange,
  editable,
  leading,
  testID,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
  leading: React.ReactNode;
  testID: string;
}) {
  return (
    <View style={{ gap: space(2) }}>
      <Text variant="overline" muted style={styles.inset}>
        {label}
      </Text>
      <TextField
        value={value}
        onChangeText={(text) => onChange(moneyInput(text))}
        editable={editable}
        keyboardType="decimal-pad"
        importantForAutofill="no"
        leading={leading}
        accessibilityLabel={label}
        testID={testID}
      />
      {hint ? (
        <Text variant="caption" muted style={styles.inset}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(6) },
  inset: { paddingHorizontal: space(1) },
  toggle: { flexDirection: "row", alignItems: "center", gap: space(3), padding: space(4) },
  dollar: { paddingLeft: space(4), marginRight: -space(3), fontSize: 16 },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    borderRadius: 12,
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
  },
  offline: { flexDirection: "row", alignItems: "center", gap: space(2) },
  spent: { gap: space(2.5) },
  spentLine: { flexDirection: "row", justifyContent: "space-between", gap: space(4) },
  track: { height: 8, borderRadius: 4, overflow: "hidden" },
  bar: { height: "100%", borderRadius: 4 },
});
