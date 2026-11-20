"use client";

import {
  accountTool,
  invalidRulePattern,
  rulesCover,
  shellScript,
  simpleCommands,
  suggestedRule,
  type RuleKind,
} from "@open-bot/domain";
import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { InlineCode } from "@/components/inline-code";

/** What a command rule would leave out of this request, so it's clear the teammate will still ask. */
function coverageNote(subject: string, pattern: string, teammateName: string): string | null {
  const commands = simpleCommands(shellScript(subject));
  if (!commands)
    return `Commands that write to files or run other commands inside $( ) still ask first.`;
  const missed = commands.filter(
    (command) => !rulesCover([{ kind: "command", pattern }], "command", command),
  );
  if (missed.length === 0) return null;
  return `This doesn't cover ${missed.map((command) => `\`${command}\``).join(", ")}, so ${teammateName} will still ask about ${missed.length === 1 ? "it" : "them"}.`;
}

/** "Always allow `git push` for Kit…": what the rule would cover, before you open it. */
function AlwaysAllowLabel({
  kind,
  subject,
  teammateName,
}: {
  kind: RuleKind;
  subject: string;
  teammateName: string;
}) {
  const prefix = kind === "command" ? suggestedRule(kind, subject) : "";
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      Always allow
      {prefix && (
        <code className="max-w-[16ch] truncate font-mono text-[0.9em] text-foreground/85">
          {prefix}
        </code>
      )}
      <span className="truncate">for {teammateName}…</span>
    </span>
  );
}

/**
 * Approve, and let the teammate do things like this from now on without asking.
 * Commands are allowed by how they start; actions by their wording, which you can edit.
 */
export function AlwaysAllowButton({
  kind,
  subject,
  teammateName,
  disabled,
  onConfirm,
}: {
  kind: RuleKind;
  /** The raw command, or the action's title. */
  subject: string;
  teammateName: string;
  disabled?: boolean;
  onConfirm: (pattern: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pattern, setPattern] = useState(() => suggestedRule(kind, subject));
  const [saving, setSaving] = useState(false);
  const problem = invalidRulePattern(kind, pattern);
  const note = kind === "command" && !problem ? coverageNote(subject, pattern, teammateName) : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPattern(suggestedRule(kind, subject));
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="lg"
          variant="ghost"
          disabled={disabled}
          className="min-w-0 px-3 font-normal text-muted-foreground hover:text-foreground"
          data-testid="always-allow"
        >
          <AlwaysAllowLabel kind={kind} subject={subject} teammateName={teammateName} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (problem) return;
            setSaving(true);
            try {
              await onConfirm(pattern.trim());
              setOpen(false);
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-done" />
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">
                {kind === "command"
                  ? `Let ${teammateName} run commands starting with`
                  : kind === "file_change"
                    ? `Let ${teammateName} change files without asking`
                    : kind === "account_write"
                      ? `Let ${teammateName} ${(accountTool(subject)?.label ?? "do this").replace(/^./, (first) => first.toLowerCase())} without asking`
                      : `Let ${teammateName} do this without asking`}
              </span>
              <span className="text-[12.5px] text-muted-foreground">
                {kind === "account_write" &&
                  "Only for changes only you see: anything others see still asks. "}
                This approves the request now. You can remove the rule on {teammateName}&apos;s
                profile.
              </span>
            </div>
          </div>
          {kind !== "file_change" && kind !== "account_write" && (
            <Input
              autoFocus
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              className={kind === "command" ? "font-mono text-[13px]" : undefined}
              maxLength={300}
              aria-invalid={problem !== null && pattern.trim() !== ""}
              data-testid="always-allow-pattern"
            />
          )}
          {problem && pattern.trim() !== "" ? (
            <p className="-mt-1.5 text-[12.5px] text-destructive">{problem}</p>
          ) : (
            kind === "command" &&
            !problem &&
            note && (
              <p
                className="-mt-1.5 text-[12.5px] text-muted-foreground"
                data-testid="always-allow-note"
              >
                <InlineCode text={note} />
              </p>
            )
          )}
          <Button
            type="submit"
            size="sm"
            disabled={problem !== null || saving}
            data-testid="always-allow-confirm"
          >
            {saving && <Loader2 className="animate-spin" />}
            Approve and always allow
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
