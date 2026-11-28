import { useSyncExternalStore } from "react";

/**
 * Which teammates are being archived right now, for every screen that shows them: their profile's
 * pencil and its Manage actions stay off until it's done, even on a profile opened again meanwhile.
 */
export class ArchivingTeammates {
  private readonly ids = new Set<string>();
  private readonly listeners = new Set<() => void>();

  has(teammateId: string): boolean {
    return this.ids.has(teammateId);
  }

  /** Marks a teammate as on its way out, or done (archived, or refused). */
  set(teammateId: string, archiving: boolean) {
    if (archiving === this.ids.has(teammateId)) return;
    if (archiving) this.ids.add(teammateId);
    else this.ids.delete(teammateId);
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export const archivingTeammates = new ArchivingTeammates();

/** Whether this teammate is being archived now. */
export function useArchiving(teammateId: string): boolean {
  return useSyncExternalStore(archivingTeammates.subscribe, () =>
    archivingTeammates.has(teammateId),
  );
}
