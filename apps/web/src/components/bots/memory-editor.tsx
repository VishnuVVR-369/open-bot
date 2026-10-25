"use client";

import { MemoryManager } from "@/components/memory/memory-manager";

export function MemoryEditor({ botId, name }: { botId: string; name: string }) {
  return <MemoryManager botId={botId} name={name} />;
}
