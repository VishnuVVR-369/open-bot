"use client";

import type { ModelRequestBodies } from "@open-bot/api";
import type { ModelItemKind } from "@open-bot/domain";
import {
  Brain,
  CornerDownRight,
  FileQuestion,
  Settings2,
  Sparkles,
  UserRound,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useRequestBodies } from "../hooks";
import { ClampedText, CopyButton, JsonBlock } from "./text-block";

/** Over a WebSocket, which input items the message itself sent and which carried over. */
function carriedNote(sent: number, carried: number): string {
  const what = sent === 1 ? "1 new item" : `${sent} new items`;
  const earlier = carried === 1 ? "The earlier item" : `The ${carried} earlier items`;
  return `This message sent ${what}. ${earlier} carried over from the previous response on the same connection, shown as the model saw ${carried === 1 ? "it" : "them"}.`;
}

const KIND_ICON: Record<ModelItemKind, typeof Brain> = {
  user: UserRound,
  assistant: Sparkles,
  system: Settings2,
  tool_call: Wrench,
  tool_output: CornerDownRight,
  reasoning: Brain,
  other: FileQuestion,
};

/** The latest input items show first; the rest of a long conversation is a click away. */
const LATEST_ITEMS = 12;

type Item = ModelRequestBodies["output"][number] & { sent?: boolean };

function ItemRow({ item }: { item: Item }) {
  const [raw, setRaw] = useState(false);
  const Icon = KIND_ICON[item.kind];
  return (
    <li className="flex min-w-0 flex-col gap-1.5 py-3" data-testid="model-item">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] font-medium",
            item.kind === "user" ? "bg-foreground text-background" : "bg-subtle text-foreground",
          )}
          data-testid="model-item-label"
        >
          <Icon className="size-3.5" />
          {item.label}
        </span>
        <span className="text-[12px] text-muted-foreground tabular-nums">#{item.position}</span>
        {item.callId && (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">
            {item.callId}
          </span>
        )}
        {item.json && (
          <button
            type="button"
            onClick={() => setRaw((value) => !value)}
            aria-pressed={raw}
            className="ml-auto rounded px-1.5 text-[12px] text-muted-foreground hover:text-foreground aria-pressed:text-foreground"
          >
            JSON
          </button>
        )}
      </div>
      {raw && item.json ? (
        <JsonBlock json={item.json} label={item.type ?? "Item"} />
      ) : (
        <ClampedText
          text={item.text}
          mono={item.kind === "tool_call" || item.kind === "tool_output"}
        />
      )}
    </li>
  );
}

function InputItems({ bodies }: { bodies: ModelRequestBodies }) {
  const [all, setAll] = useState(false);
  const items = bodies.input;
  const hidden = all ? 0 : Math.max(0, items.length - LATEST_ITEMS);
  const shown = items.slice(hidden);
  const carried = items.filter((item) => !item.sent).length;
  return (
    <div className="flex min-w-0 flex-col">
      {carried > 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          {carriedNote(items.length - carried, carried)}
        </p>
      )}
      {bodies.missingInput.length > 0 && (
        <p className="text-[12.5px] text-destructive">
          {bodies.missingInput.length === 1
            ? "1 item is missing from the logs."
            : `${bodies.missingInput.length} items are missing from the logs.`}
        </p>
      )}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-2 self-start rounded-md border px-2.5 py-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
          data-testid="show-earlier-items"
        >
          Show {hidden} earlier {hidden === 1 ? "item" : "items"}
        </button>
      )}
      <ol className="flex min-w-0 flex-col divide-y">
        {shown.map((item) => (
          <ItemRow key={item.position} item={item} />
        ))}
      </ol>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[13px] text-muted-foreground">{children}</p>;
}

function Headers({ title, headers }: { title: string; headers: Record<string, string> | null }) {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h4 className="text-[12.5px] font-medium text-muted-foreground">{title}</h4>
      <dl className="grid min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-0.5 font-mono text-[12px]">
        {entries.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="truncate text-muted-foreground">{name}</dt>
            <dd className="[overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The body as it was sent, rebuilt from its parts, for copying out. */
function rebuiltBody(bodies: ModelRequestBodies): string {
  const parse = (text: string | null) => {
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
  const params = (parse(bodies.params) ?? {}) as Record<string, unknown>;
  return JSON.stringify(
    {
      ...params,
      ...(bodies.instructions !== null ? { instructions: bodies.instructions } : {}),
      ...(bodies.tools.length ? { tools: bodies.tools.map((tool) => parse(tool.json)) } : {}),
      input: bodies.input.map((item) => parse(item.json)),
    },
    null,
    2,
  );
}

function Bodies({ bodies }: { bodies: ModelRequestBodies }) {
  return (
    <Tabs defaultValue="input" className="min-w-0 gap-3">
      <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none]">
        <TabsList variant="line" className="w-max">
          <TabsTrigger value="input">Input · {bodies.input.length}</TabsTrigger>
          <TabsTrigger value="instructions">Instructions</TabsTrigger>
          <TabsTrigger value="tools">Tools · {bodies.tools.length}</TabsTrigger>
          <TabsTrigger value="response">Response</TabsTrigger>
          <TabsTrigger value="request">Request</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="input" className="min-w-0">
        {bodies.input.length ? (
          <InputItems bodies={bodies} />
        ) : (
          <Empty>No input items were stored.</Empty>
        )}
      </TabsContent>
      <TabsContent value="instructions" className="min-w-0">
        {bodies.instructions ? (
          <ClampedText text={bodies.instructions} />
        ) : (
          <Empty>This request sent no instructions.</Empty>
        )}
      </TabsContent>
      <TabsContent value="tools" className="min-w-0">
        {bodies.tools.length ? (
          <ul className="flex min-w-0 flex-col divide-y">
            {bodies.tools.map((tool, index) => (
              <ToolRow key={`${tool.name}-${index}`} tool={tool} />
            ))}
          </ul>
        ) : (
          <Empty>This request offered no tools.</Empty>
        )}
      </TabsContent>
      <TabsContent value="response" className="flex min-w-0 flex-col gap-4">
        {bodies.reasoningSummary && (
          <section className="flex flex-col gap-1">
            <h4 className="text-[12.5px] font-medium text-muted-foreground">Reasoning summary</h4>
            <ClampedText text={bodies.reasoningSummary} />
          </section>
        )}
        {bodies.output.length > 0 && (
          <ol className="flex min-w-0 flex-col divide-y">
            {bodies.output.map((item) => (
              <ItemRow key={item.position} item={item} />
            ))}
          </ol>
        )}
        {bodies.rawResponse && (
          <section className="flex flex-col gap-1">
            <h4 className="text-[12.5px] font-medium text-muted-foreground">
              The response as it came, since it couldn&apos;t be read
            </h4>
            <JsonBlock json={bodies.rawResponse} label="Raw response" />
          </section>
        )}
        {!bodies.output.length && !bodies.rawResponse && !bodies.reasoningSummary && (
          <Empty>No response was stored.</Empty>
        )}
      </TabsContent>
      <TabsContent value="request" className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12.5px] text-muted-foreground">
            The body rebuilt from its stored parts, to send again or compare.
          </p>
          <CopyButton text={rebuiltBody(bodies)} label="Copy body" />
        </div>
        {bodies.params && <JsonBlock json={bodies.params} label="Parameters" />}
        <Headers title="Request headers" headers={bodies.requestHeaders} />
        <Headers title="Response headers" headers={bodies.responseHeaders} />
      </TabsContent>
    </Tabs>
  );
}

function ToolRow({ tool }: { tool: ModelRequestBodies["tools"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex min-w-0 flex-col gap-1.5 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-w-0 flex-col items-start gap-0.5 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="font-mono text-[12.5px] font-medium">{tool.name}</span>
          <span className="text-[12px] text-muted-foreground">{tool.type}</span>
        </span>
        {tool.description && (
          <span className="line-clamp-2 text-[12.5px] text-muted-foreground">
            {tool.description}
          </span>
        )}
      </button>
      {open && <JsonBlock json={tool.json} label="Definition" />}
    </li>
  );
}

/** A request's bodies, loaded when it is opened. */
export function RequestBodies({ requestId }: { requestId: string }) {
  const bodies = useRequestBodies(requestId, true);
  if (bodies.data) return <Bodies bodies={bodies.data} />;
  if (bodies.error)
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[13px]">
        <span className="text-muted-foreground">
          Couldn&apos;t load this request. {bodies.error.message}
        </span>
        <button
          type="button"
          className="text-[12.5px] font-medium"
          onClick={() => void bodies.refetch()}
        >
          Try again
        </button>
      </div>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="request-bodies-loading">
      <Skeleton className="h-8 w-72 rounded-lg" />
      <Skeleton className="h-32 w-full rounded-lg" />
    </div>
  );
}
