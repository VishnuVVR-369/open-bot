"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { readMemory, saveMemory } from "@/lib/actions";

export function MemoryEditor({ slug, name }: { slug: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    setError(null);
    const result = await readMemory(slug);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setText(result.data);
    setSaved(result.data);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed px-5 py-6">
        <p className="text-[14px]">
          {name}&apos;s memory isn&apos;t readable right now:{" "}
          <span className="text-muted-foreground">{error}</span>
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RotateCcw />
          Try again
        </Button>
      </div>
    );
  }
  if (text === null) return <Skeleton className="h-72 w-full rounded-xl" />;

  const dirty = text !== saved;
  return (
    <div className="flex flex-col gap-3">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="min-h-80 font-mono text-[13px] leading-relaxed"
        aria-label={`${name}'s memory`}
        spellCheck={false}
      />
      <div className="flex items-center gap-3">
        <Button
          disabled={!dirty || pending}
          onClick={() =>
            startTransition(async () => {
              const result = await saveMemory(slug, text);
              if (!result.ok) {
                toast.error(result.error);
                return;
              }
              setSaved(text);
              toast("Memory saved");
            })
          }
        >
          {pending && <Loader2 className="animate-spin" />}
          Save memory
        </Button>
        <Button variant="ghost" disabled={pending} onClick={() => void load()}>
          Reload
        </Button>
        <span className="text-[12.5px] text-muted-foreground">
          {dirty
            ? "Unsaved changes."
            : `${name} reads this at the start of tasks and keeps it up to date.`}
        </span>
      </div>
    </div>
  );
}
