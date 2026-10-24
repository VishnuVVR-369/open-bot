"use client";

import { MAX_ABOUT_ME_CHARS } from "@open-bot/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { saveProfile } from "@/lib/actions";
import { queryKeys, useProfile } from "@/lib/client/queries";
import { cn } from "@/lib/utils";

const PLACEHOLDER = `I'm Sam, a product designer in Lisbon.
- Home: Rua Example 12, 1200-123 Lisbon
- Vegetarian, allergic to peanuts
- Prefer window seats and TAP or easyJet
- Don't book anything before 9 AM`;

/** What every teammate knows about you. Teammates add to it as they learn. */
export function ProfileEditor() {
  const { data, error, refetch } = useProfile();
  const queryClient = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The saved text the editor started from, to tell your edits from a teammate's.
  const base = useRef<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setText((current) => {
      // Keep your unsaved edits; otherwise show what a teammate just added.
      if (current === null || current === base.current) {
        base.current = data.aboutMe;
        return data.aboutMe;
      }
      return current;
    });
  }, [data]);

  if (error && !data)
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[13.5px] text-muted-foreground">Your profile didn&apos;t load.</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  if (text === null || !data) return <Skeleton className="h-56 w-full rounded-xl" />;

  const dirty = text !== base.current;
  const changedElsewhere = dirty && data.aboutMe !== base.current;
  const tooLong = text.length > MAX_ABOUT_ME_CHARS;

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={PLACEHOLDER}
        className="min-h-56 text-[14px] leading-relaxed"
        aria-label="About you"
        data-testid="profile-input"
      />
      {changedElsewhere && (
        <p className="text-[12.5px] text-waiting">
          A teammate added to your profile while you were editing.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            onClick={() => {
              base.current = data.aboutMe;
              setText(data.aboutMe);
            }}
          >
            Show theirs
          </button>{" "}
          (your edits are discarded) or save yours over it.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!dirty || pending || tooLong}
          onClick={() =>
            startTransition(async () => {
              const result = await saveProfile(text);
              if (!result.ok) {
                toast.error("Couldn't save your profile", { description: result.error });
                return;
              }
              base.current = text.replace(/\s+$/, "");
              setText(base.current);
              await queryClient.invalidateQueries({ queryKey: queryKeys.profile });
              toast("Profile saved", { description: "Teammates use it from their next message." });
            })
          }
        >
          {pending && <Loader2 className="animate-spin" />}
          Save profile
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              base.current = data.aboutMe;
              setText(data.aboutMe);
            }}
          >
            Discard
          </Button>
        )}
        <span
          className={cn(
            "ml-auto text-[12.5px] text-muted-foreground tabular-nums",
            tooLong && "text-destructive",
          )}
        >
          {text.length.toLocaleString()} / {MAX_ABOUT_ME_CHARS.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
