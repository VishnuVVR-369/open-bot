"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Globe, Loader2, Pencil, Plug, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { AccessPicker } from "@/components/access-picker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  deleteConnection,
  saveConnection,
  setConnectionEnabled,
  testConnection,
} from "@/lib/actions";
import { queryKeys, useAppState, useConnections } from "@/lib/client/queries";
import type { ConnectionTestView, ConnectionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AccountsSection } from "./accounts-section";
import { TestResult } from "./connection-test-result";

function where(connection: ConnectionView): string {
  if (connection.transport === "stdio")
    return [connection.command, ...connection.args].filter(Boolean).join(" ");
  try {
    const url = new URL(connection.url ?? "");
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return connection.url ?? "";
  }
}

/** Add a service, or edit one when `connection` is given. */
function ConnectionDialog({
  connection,
  trigger,
  onSaved,
}: {
  connection?: ConnectionView;
  trigger: ReactNode;
  onSaved: (id: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [secrets, setSecrets] = useState("");
  const [access, setAccess] = useState<string[] | null>(null);
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    setLabel(connection?.label ?? "");
    setTransport(connection?.transport ?? "http");
    setUrl(connection?.url ?? "");
    setCommand(connection?.command ?? "");
    setArgs((connection?.args ?? []).map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "));
    setSecrets("");
    setAccess(connection ? connection.botIds : null);
  }, [open, connection]);

  const kept = connection && connection.transport === transport && connection.secretNames.length;
  const ready =
    label.trim() &&
    (transport === "http" ? url.trim() : command.trim()) &&
    (access === null || access.length > 0);

  function submit() {
    startTransition(async () => {
      const result = await saveConnection({
        id: connection?.id ?? null,
        label: label.trim(),
        transport,
        url,
        command,
        args,
        secrets,
        botIds: access,
      });
      if (!result.ok) {
        toast.error("Couldn't save it", { description: result.error });
        return;
      }
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections });
      onSaved(result.data.id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg" data-testid="connection-dialog">
        <DialogHeader>
          <DialogTitle>{connection ? `Edit ${connection.label}` : "Connect a service"}</DialogTitle>
          <DialogDescription>
            Any service with an MCP server: GitHub, Notion, Linear, your own API. Teammates use its
            tools directly, which is faster and more reliable than its website.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !pending) submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-label`}>Name</Label>
            <Input
              id={`${id}-label`}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="GitHub"
              maxLength={60}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>How it connects</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={transport}
              onValueChange={(value) => value && setTransport(value as "http" | "stdio")}
              className="w-full"
            >
              <ToggleGroupItem value="http" className="flex-1">
                <Globe />
                Web address
              </ToggleGroupItem>
              <ToggleGroupItem value="stdio" className="flex-1">
                <SquareTerminal />
                Command on the computer
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          {transport === "http" ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-url`}>MCP address</Label>
                <Input
                  id={`${id}-url`}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://api.example.com/mcp"
                  spellCheck={false}
                  autoCapitalize="off"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-headers`}>Headers</Label>
                <Textarea
                  id={`${id}-headers`}
                  value={secrets}
                  onChange={(event) => setSecrets(event.target.value)}
                  placeholder={
                    kept
                      ? `Saved: ${connection!.secretNames.join(", ")}. Type to replace them.`
                      : "Authorization: Bearer your-token"
                  }
                  spellCheck={false}
                  className="min-h-16 font-mono text-[13px]"
                />
                <span className="text-[12.5px] text-muted-foreground">
                  One per line, usually the token the service gave you. Stored encrypted.
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-command`}>Command</Label>
                  <Input
                    id={`${id}-command`}
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="npx"
                    spellCheck={false}
                    autoCapitalize="off"
                    className="font-mono text-[13px]"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-args`}>Arguments</Label>
                  <Input
                    id={`${id}-args`}
                    value={args}
                    onChange={(event) => setArgs(event.target.value)}
                    placeholder="-y @modelcontextprotocol/server-github"
                    spellCheck={false}
                    autoCapitalize="off"
                    className="font-mono text-[13px]"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-env`}>Environment variables</Label>
                <Textarea
                  id={`${id}-env`}
                  value={secrets}
                  onChange={(event) => setSecrets(event.target.value)}
                  placeholder={
                    kept
                      ? `Saved: ${connection!.secretNames.join(", ")}. Type to replace them.`
                      : "GITHUB_TOKEN=your-token"
                  }
                  spellCheck={false}
                  className="min-h-16 font-mono text-[13px]"
                />
                <span className="text-[12.5px] text-muted-foreground">
                  It runs on the shared computer. Variables are stored encrypted.
                </span>
              </div>
            </>
          )}
          <div className="rounded-xl border bg-subtle/60 p-3.5">
            <AccessPicker value={access} onChange={setAccess} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || pending} data-testid="connection-save">
              {pending && <Loader2 className="animate-spin" />}
              {connection ? "Save" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionRow({
  connection,
  result,
  testing,
  onTest,
}: {
  connection: ConnectionView;
  result: ConnectionTestView | undefined;
  testing: boolean;
  onTest: () => void;
}) {
  const { data: state } = useAppState();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.connections });
  const people =
    connection.botIds === null
      ? "Every teammate"
      : connection.botIds.length === 1
        ? `Only ${state?.bots.find((bot) => bot.id === connection.botIds![0])?.name ?? "one teammate"}`
        : `${connection.botIds.length} teammates`;

  return (
    <li className="flex flex-col gap-2.5 px-4 py-3" data-testid="connection">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-subtle text-muted-foreground",
            !connection.enabled && "opacity-50",
          )}
        >
          {connection.transport === "http" ? (
            <Plug className="size-4" />
          ) : (
            <SquareTerminal className="size-4" />
          )}
        </span>
        <div className={cn("flex min-w-0 flex-1 flex-col", !connection.enabled && "opacity-60")}>
          <span className="truncate text-[14px] font-medium">{connection.label}</span>
          <span className="flex min-w-0 gap-2 text-[12.5px] text-muted-foreground">
            <span className="truncate font-mono text-[12px]">{where(connection)}</span>
            <span className="shrink-0">· {people}</span>
            {!connection.enabled && <span className="shrink-0">· Off</span>}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={onTest} disabled={testing}>
          {testing && <Loader2 className="animate-spin" />}
          Test
        </Button>
        <ConnectionDialog
          connection={connection}
          onSaved={onTest}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${connection.label}`}>
              <Pencil />
            </Button>
          }
        />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${connection.label}`}>
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {connection.label}?</AlertDialogTitle>
              <AlertDialogDescription>
                Teammates lose its tools from their next message.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={async () => {
                  const removed = await deleteConnection(connection.id);
                  if (!removed.ok) toast.error(removed.error);
                  await refresh();
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Switch
          checked={connection.enabled}
          aria-label={`Use ${connection.label}`}
          onCheckedChange={async (checked) => {
            const changed = await setConnectionEnabled(connection.id, checked);
            if (!changed.ok) toast.error(changed.error);
            await refresh();
          }}
        />
      </div>
      {testing ? (
        <p className="flex items-center gap-2 pl-12 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Connecting from the computer…
        </p>
      ) : (
        result && (
          <div className="pl-12">
            <TestResult result={result} />
          </div>
        )
      )}
    </li>
  );
}

/** Your accounts, and services teammates use through MCP. */
export function ConnectionsSection() {
  const { data, isLoading } = useConnections();
  const [results, setResults] = useState<Record<string, ConnectionTestView>>({});
  const [testing, setTesting] = useState<string | null>(null);

  // Back from signing in to Google or Notion: say how it went, and test what was connected.
  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get("connected");
    const error = url.searchParams.get("account_error");
    const missing = url.searchParams.get("missing");
    if (!connected && !error) return;
    for (const key of ["connected", "account_error", "missing"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
    if (error) toast.error("Couldn't connect", { description: error });
    if (connected) {
      if (missing)
        toast.warning("Connected, with less than you asked for", {
          description: `It didn't grant ${missing.split(",").join(" or ")}. Teammates can't do that until you reconnect and allow it.`,
        });
      else toast.success("Connected");
      void test(connected);
    }
  }, []);

  async function test(id: string) {
    setTesting(id);
    // An earlier result would read as this one's.
    setResults((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    const result = await testConnection(id);
    setTesting(null);
    setResults((current) => ({
      ...current,
      [id]: result.ok ? result.data : { ok: false, status: null, tools: [], error: result.error },
    }));
  }

  if (isLoading) return <Skeleton className="h-20 rounded-xl" />;
  const all = data ?? [];
  const connections = all.filter((connection) => connection.kind === "mcp");

  return (
    <div className="flex flex-col gap-6">
      <AccountsSection
        connections={all}
        results={results}
        testing={testing}
        onTest={(id) => void test(id)}
      />
      <div className="flex flex-col gap-3" data-testid="connections">
        <span className="text-[13px] font-medium text-muted-foreground">
          Other services, through MCP
        </span>
        {connections.length > 0 ? (
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                result={results[connection.id]}
                testing={testing === connection.id}
                onTest={() => void test(connection.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed px-4 py-3.5 text-[13.5px] text-muted-foreground">
            Nothing connected yet. Connect a service, and teammates use its tools instead of
            clicking through its website.
          </p>
        )}
        <ConnectionDialog
          onSaved={(id) => void test(id)}
          trigger={
            <Button variant="outline" className="self-start">
              <Plus />
              Connect a service
            </Button>
          }
        />
      </div>
    </div>
  );
}
