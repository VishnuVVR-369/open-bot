"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { attempt } from "@/lib/client/mutate";
import { useAppState } from "@/lib/client/queries";
import { api, orpc } from "@/lib/client/rpc";

/** For a value that never changes while the page is open. */
const noSubscription = () => () => {};

export function TimezoneSection() {
  const { data: state } = useAppState();
  const queryClient = useQueryClient();
  const zones = useMemo(() => {
    const supported =
      (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
        "timeZone",
      ) ?? [];
    return supported.includes("UTC") ? supported : ["UTC", ...supported];
  }, []);
  // The device's zone is only known in the browser; the server renders without the suggestion,
  // so both sides agree until hydration ends.
  const browserZone = useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null,
  );
  const current = state?.timezone ?? "UTC";
  const save = async (zone: string) => {
    const result = await attempt(api.settings.setTimezone({ timezone: zone }));
    if (!result.ok) toast.error(result.error);
    else toast("Timezone saved", { description: zone });
    await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={current} onValueChange={(zone) => void save(zone)}>
        <SelectTrigger className="w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-80">
          {zones.map((zone) => (
            <SelectItem key={zone} value={zone}>
              {zone.replace(/_/g, " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {browserZone && browserZone !== current && (
        <Button variant="ghost" size="sm" onClick={() => void save(browserZone)}>
          Use {browserZone.replace(/_/g, " ")}
        </Button>
      )}
    </div>
  );
}
