import {
  accountTool,
  invalidRulePattern,
  rulesCover,
  shellScript,
  simpleCommands,
  suggestedRule,
  type RuleKind,
} from "@open-bot/domain";
import { ShieldCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "@/components/button";
import { Sheet } from "@/components/sheet";
import { Text } from "@/components/text";
import { TextField } from "@/components/text-field";
import { space, useColors } from "@/theme";

/** What a command rule would leave out of this request, so it's clear the teammate still asks. */
function coverageNote(subject: string, pattern: string, botName: string): string | null {
  const commands = simpleCommands(shellScript(subject));
  if (!commands)
    return "Commands that write to files or run other commands inside $( ) still ask first.";
  const missed = commands.filter(
    (command) => !rulesCover([{ kind: "command", pattern }], "command", command),
  );
  if (missed.length === 0) return null;
  return `This doesn't cover ${missed.join(", ")}, so ${botName} will still ask about ${missed.length === 1 ? "it" : "them"}.`;
}

/**
 * Approve, and let the teammate do things like this from now on without asking, as on the web.
 * Commands are allowed by how they start; actions by their wording, which you can edit.
 */
export function AlwaysAllowSheet({
  open,
  onClose,
  kind,
  subject,
  botName,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  kind: RuleKind;
  /** The raw command, or the action's wording. */
  subject: string;
  botName: string;
  onConfirm: (pattern: string) => Promise<void>;
}) {
  const colors = useColors();
  const [pattern, setPattern] = useState(() => suggestedRule(kind, subject));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setPattern(suggestedRule(kind, subject));
  }, [open, kind, subject]);
  const problem = invalidRulePattern(kind, pattern);
  const note = kind === "command" && !problem ? coverageNote(subject, pattern, botName) : null;

  const confirm = async () => {
    if (problem) return;
    setSaving(true);
    try {
      await onConfirm(pattern.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} testID="always-allow-sheet">
      <View style={styles.body}>
        <View style={styles.head}>
          <ShieldCheck size={18} color={colors.done} style={{ marginTop: 2 }} />
          <View style={{ flex: 1, gap: space(1) }}>
            <Text variant="label">
              {kind === "command"
                ? `Let ${botName} run commands starting with`
                : kind === "file_change"
                  ? `Let ${botName} change files without asking`
                  : kind === "account_write"
                    ? `Let ${botName} ${(accountTool(subject)?.label ?? "do this").replace(/^./, (first) => first.toLowerCase())} without asking`
                    : `Let ${botName} do this without asking`}
            </Text>
            <Text variant="small" muted>
              {kind === "account_write" &&
                "Only for changes only you see: anything others see still asks. "}
              This approves the request now. You can remove the rule from Approvals.
            </Text>
          </View>
        </View>
        {kind !== "file_change" && kind !== "account_write" && (
          <TextField
            value={pattern}
            onChangeText={setPattern}
            mono={kind === "command"}
            maxLength={300}
            autoCapitalize="none"
            autoCorrect={false}
            invalid={problem !== null && pattern.trim() !== ""}
            testID="always-allow-pattern"
          />
        )}
        {problem && pattern.trim() !== "" ? (
          <Text variant="small" style={{ color: colors.destructive }}>
            {problem}
          </Text>
        ) : note ? (
          <Text variant="small" muted testID="always-allow-note">
            {note}
          </Text>
        ) : null}
        <Button
          title="Approve and always allow"
          onPress={() => void confirm()}
          disabled={problem !== null}
          busy={saving}
          testID="always-allow-confirm"
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space(5), paddingTop: space(1), gap: space(3) },
  head: { flexDirection: "row", gap: space(2.5) },
});
