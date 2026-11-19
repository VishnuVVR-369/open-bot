"use client";

import type { RunLogStatus } from "@open-bot/domain";
import { Download, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { exportRangeHref, rangeBounds, rangeLabel, rangeOf, withRange } from "../ranges";
import { useModelLogFilterOptions } from "../hooks";
import { FilterSelect, RangePicker, useAddress } from "./controls";

const STATUSES: { value: RunLogStatus; label: string }[] = [
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "stopped", label: "Stopped" },
  { value: "working", label: "Working" },
  { value: "errors", label: "With failed requests" },
];

const ACCESS = [
  { value: "plan", label: "ChatGPT plan" },
  { value: "api_key", label: "API key" },
];

/** The keys the runs list's filters keep in the address. */
const FILTER_KEYS = ["q", "teammate", "chat", "model", "status", "access", "range", "from", "to"];

/** "Last 7 days" as "the last 7 days", "Since Nov 1" as "since Nov 1"; dates stay as they are. */
function exportLabel(label: string): string {
  if (label.startsWith("Last")) return `the l${label.slice(1)}`;
  return /^(Today|Since|Until)/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
}

/** Words to find, written to the address a moment after typing stops. */
function SearchBox() {
  const { params, setParam } = useAddress();
  const current = params.get("q") ?? "";
  const [text, setText] = useState(current);
  const written = useRef(current);
  // Cleared or changed from outside (the back button, "Clear filters"): show that.
  useEffect(() => {
    if (current !== written.current) {
      written.current = current;
      setText(current);
    }
  }, [current]);
  useEffect(() => {
    if (text.trim() === written.current.trim()) return;
    const timer = setTimeout(() => {
      written.current = text.trim();
      setParam("q", text.trim() || null);
    }, 350);
    return () => clearTimeout(timer);
  });
  return (
    <form
      role="search"
      className="relative w-full max-w-[440px]"
      onSubmit={(event) => {
        event.preventDefault();
        written.current = text.trim();
        setParam("q", text.trim() || null);
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Search what was sent and what came back"
        aria-label="Search model logs"
        className="h-8 pr-8 pl-8 text-[13.5px] [&::-webkit-search-cancel-button]:hidden"
        maxLength={1000}
        data-testid="model-logs-search"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setText("");
            written.current = "";
            setParam("q", null);
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </form>
  );
}

/** Search, then the filters in one row, and an export of the chosen dates. */
export function RunFilters() {
  const { params, set, setParam } = useAddress();
  const options = useModelLogFilterOptions();
  const range = rangeOf(params);
  const exportHref = exportRangeHref(rangeBounds(range));
  const filtered = FILTER_KEYS.some((key) => params.has(key));
  const clear = () => {
    const next = new URLSearchParams(params);
    for (const key of FILTER_KEYS) next.delete(key);
    set(next);
  };
  const teammates = options.data?.teammates ?? [];
  const chats = options.data?.chats ?? [];
  const models = options.data?.models ?? [];
  return (
    <div className="flex flex-col gap-2.5" data-testid="model-logs-filters">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <SearchBox />
        {exportHref && (
          <Button variant="ghost" size="sm" className="-mx-2 sm:mx-0" asChild>
            <a
              href={exportHref}
              download
              title="Every model request in these dates, whatever the other filters, one JSON object per line"
              data-testid="export-range"
            >
              <Download />
              Export {exportLabel(rangeLabel(range))}
            </a>
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RangePicker
          choice={range}
          onChange={(choice) => set(withRange(params, choice))}
          testId="runs-range"
        />
        <FilterSelect
          label="Teammate"
          allLabel="All teammates"
          value={params.get("teammate") ?? undefined}
          options={teammates.map((t) => ({ value: t.id, label: t.name }))}
          onChange={(value) => setParam("teammate", value)}
          testId="filter-teammate"
        />
        <FilterSelect
          label="Chat"
          allLabel="All chats"
          value={params.get("chat") ?? undefined}
          options={chats.map((c) => ({ value: c.id, label: c.title || "Untitled chat" }))}
          onChange={(value) => setParam("chat", value)}
          className="max-w-[220px]"
          testId="filter-chat"
        />
        <FilterSelect
          label="Model"
          allLabel="All models"
          value={params.get("model") ?? undefined}
          options={models.map((m) => ({ value: m, label: m }))}
          onChange={(value) => setParam("model", value)}
          testId="filter-model"
        />
        <FilterSelect
          label="Status"
          allLabel="Any status"
          value={params.get("status") ?? undefined}
          options={STATUSES}
          onChange={(value) => setParam("status", value)}
          testId="filter-status"
        />
        <FilterSelect
          label="Access"
          allLabel="Plan or API key"
          value={params.get("access") ?? undefined}
          options={ACCESS}
          onChange={(value) => setParam("access", value)}
          testId="filter-access"
        />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clear} data-testid="clear-filters">
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}
