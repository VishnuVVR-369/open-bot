"use client";

import {
  eventChangeLabel,
  eventTime,
  previewNote,
  previewText,
  type AccountActionPreview,
} from "@open-bot/domain";
import {
  CalendarDays,
  ChevronDown,
  ExternalLink,
  Mail,
  MapPin,
  NotebookText,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The icon an approval for this action shows. */
export function previewIcon(preview: AccountActionPreview | null | undefined) {
  if (!preview) return null;
  return preview.type === "email" ? Mail : preview.type === "event" ? CalendarDays : NotebookText;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground/90">{children}</dd>
    </>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[12.5px] text-attention-ink">
      <TriangleAlert className="mt-0.5 size-3 shrink-0" />
      {children}
    </p>
  );
}

/** Whether the email's body is cut in its preview, so there's more to read before approving. */
export function emailIsClamped(preview: AccountActionPreview | null | undefined): boolean {
  return preview?.type === "email" && previewText(preview.body).cut;
}

/**
 * An email's body, cut to its first few lines so the decision stays in view. When the approval
 * controls it (`open`), its primary action reads the rest and only "Show less" shows here;
 * otherwise a "Show full email" button does.
 */
function EmailBody({
  body,
  open: controlled,
  onOpenChange,
}: {
  body: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const preview = previewText(body);
  const showToggle = preview.cut && (controlled === undefined || open);
  return (
    <div className="flex flex-col items-start gap-1.5 border-t pt-2.5">
      <div
        className="w-full font-sans text-[13px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90"
        data-testid="email-body"
      >
        {(open ? body.trim() : preview.text) || "(empty)"}
      </div>
      {showToggle && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-md text-[12.5px] font-medium text-foreground/80 underline-offset-[3px] outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/12"
        >
          {open ? "Show less" : "Show full email"}
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

/** Exactly what an action on one of your accounts will do, for its approval. */
export function ActionPreview({
  preview,
  emailOpen,
  onEmailOpenChange,
  className,
}: {
  preview: AccountActionPreview;
  /** Whether an email's whole body shows, when the approval around it decides. */
  emailOpen?: boolean;
  onEmailOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const box = cn(
    "flex min-w-0 flex-col gap-2.5 rounded-lg border bg-card px-3.5 py-3 text-[13px]",
    className,
  );

  if (preview.type === "email")
    return (
      <div className={box} data-testid="action-preview" data-type="email">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <Field label="From">{preview.account}</Field>
          <Field label="To">{preview.to.join(", ") || "Nobody yet"}</Field>
          {preview.cc.length > 0 && <Field label="Cc">{preview.cc.join(", ")}</Field>}
          {preview.bcc.length > 0 && <Field label="Bcc">{preview.bcc.join(", ")}</Field>}
          <Field label="Subject">
            <span className="font-medium text-foreground">{preview.subject || "(no subject)"}</span>
          </Field>
        </dl>
        {preview.inReplyTo && (
          <span className="text-[12.5px] text-muted-foreground">
            A reply in “{preview.inReplyTo}”
          </span>
        )}
        <EmailBody body={preview.body} open={emailOpen} onOpenChange={onEmailOpenChange} />
      </div>
    );

  if (preview.type === "event") {
    const time = eventTime(preview);
    const note = previewNote(preview);
    return (
      <div className={box} data-testid="action-preview" data-type="event">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[12.5px] text-muted-foreground">{eventChangeLabel(preview)}</span>
          <span
            className={cn(
              "text-[14px] font-medium break-words",
              preview.change === "delete" && "line-through decoration-foreground/40",
            )}
          >
            {preview.title || "(no title)"}
          </span>
          {time && <span className="text-foreground/85">{time}</span>}
        </div>
        {(preview.location || preview.guests.length > 0) && (
          <div className="flex flex-col gap-1 text-foreground/85">
            {preview.location && (
              <span className="flex min-w-0 items-start gap-1.5">
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 break-words">{preview.location}</span>
              </span>
            )}
            {preview.guests.length > 0 && (
              <span className="flex min-w-0 items-start gap-1.5">
                <Users className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 break-words">{preview.guests.join(", ")}</span>
              </span>
            )}
          </div>
        )}
        {note && <Note>{note}</Note>}
      </div>
    );
  }

  return (
    <div className={box} data-testid="action-preview" data-type="change">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] text-muted-foreground">
          {preview.action} · {preview.account}
        </span>
        {preview.url ? (
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1 self-start text-[14px] font-medium underline-offset-2 hover:underline"
          >
            <span className="truncate">{preview.target}</span>
            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
          </a>
        ) : (
          <span className="text-[14px] font-medium break-words">{preview.target}</span>
        )}
      </div>
      {preview.detail && (
        <pre className="max-h-64 overflow-auto font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/85">
          {preview.detail}
        </pre>
      )}
      {previewNote(preview) && <Note>{previewNote(preview)}</Note>}
    </div>
  );
}
