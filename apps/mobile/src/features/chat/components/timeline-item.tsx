import { splitComputerPaths, type TimelineItem } from "@open-bot/domain";
import { ArrowRightLeft, CircleDashed, FilePen, Search, SquareTerminal } from "lucide-react-native";
import { useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { FileChip } from "@/features/files/components/file-chip";
import { Markdown } from "@/components/markdown";
import {
  commandStep,
  fileChangeSummary,
  reasoningSummary,
  toolSummary,
  webSearchSummary,
} from "@/features/chat/step-text";
import { space } from "@/theme";
import { ApprovalCard } from "./approval-card";
import { PlanCard, SentIntoTurn, TakeoverCard, TurnError } from "./item-cards";
import { PageCard } from "./page-card";
import { CodeBlock, Step } from "./step";
import { SwarmCard } from "./swarm-card";
import { toolIcon } from "./tool-icons";

/** One thing a teammate did or said in a turn: a step, a card, or their words. */
export function TimelineItemView({
  teammateId,
  item,
  chatId,
  teammateName,
  approved = false,
}: {
  teammateId: string;
  item: TimelineItem;
  chatId: string;
  teammateName: string;
  /** A command you approved just before it ran: it says so instead of a separate approval line. */
  approved?: boolean;
}): ReactNode {
  switch (item.kind) {
    case "message":
      return item.phase === "final" ? (
        <View style={{ gap: space(2) }}>
          <Markdown text={item.text} />
          <MentionedFiles text={item.text} />
        </View>
      ) : (
        <Markdown text={item.text} tone="muted" />
      );
    case "reasoning":
      if (!item.text) return null;
      return (
        <Step
          icon={CircleDashed}
          running={item.status === "running"}
          summary={reasoningSummary(item.text)}
          detail={item.text.includes("\n") ? <Markdown text={item.text} tone="muted" /> : undefined}
        />
      );
    case "command": {
      const step = commandStep(item, approved);
      return (
        <Step
          icon={SquareTerminal}
          mono
          running={item.status === "running"}
          failed={step.failed}
          summary={step.summary}
          detail={
            <CodeBlock>{`$ ${step.command}\n${item.output.trim() || "(no output)"}`}</CodeBlock>
          }
        />
      );
    }
    case "file_change":
      return (
        <Step
          icon={FilePen}
          running={item.status === "running"}
          failed={item.status === "failed"}
          summary={fileChangeSummary(item)}
          detail={
            <View style={{ gap: space(2) }}>
              {item.changes.map((change) => (
                <CodeBlock key={change.path}>{`${change.path}\n${change.diff}`}</CodeBlock>
              ))}
            </View>
          }
        />
      );
    case "tool":
      return (
        <Step
          icon={toolIcon(item.name)}
          running={item.status === "running"}
          failed={item.status === "failed"}
          summary={toolSummary(item)}
        />
      );
    case "web_search":
      return (
        <Step
          icon={Search}
          running={item.status === "running"}
          summary={webSearchSummary(item.query)}
        />
      );
    case "plan":
      return <PlanCard item={item} />;
    case "approval":
      return <ApprovalCard item={item} chatId={chatId} teammateName={teammateName} />;
    case "takeover_request":
      return <TakeoverCard item={item} screenId={teammateId} name={teammateName} />;
    case "handoff":
      return (
        <Step icon={ArrowRightLeft} summary={`Handed to ${item.toBotName}: ${item.message}`} />
      );
    case "user_message":
      return <SentIntoTurn item={item} />;
    case "swarm":
      return <SwarmCard item={item} teammateName={teammateName} />;
    case "page":
      return <PageCard item={item} />;
    case "error":
      return <TurnError message={item.message} />;
    case "computer":
      return null;
  }
}

/** Files on the computer a reply mentions, as chips that open them. */
function MentionedFiles({ text }: { text: string }) {
  const paths = useMemo(
    () => [
      ...new Set(
        splitComputerPaths(text)
          .filter((part) => part.path)
          .map((part) => part.text),
      ),
    ],
    [text],
  );
  if (paths.length === 0) return null;
  return (
    <View style={styles.files}>
      {paths.map((path) => (
        <FileChip key={path} path={path} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  files: { flexDirection: "row", flexWrap: "wrap", gap: space(1.5) },
});
