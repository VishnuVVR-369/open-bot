"use client";

import {
  fileSize,
  insertMention,
  mentionedIds,
  mentionOptions,
  mentionQuery,
  sendAttempt,
  type SendAttempt,
} from "@open-bot/chat-core";
import { type RunStatus } from "@open-bot/domain";
import {
  ArrowUp,
  CloudOff,
  FileText,
  Hand,
  Loader2,
  Mic,
  Paperclip,
  ShieldAlert,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useTransition,
  type Ref,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attempt } from "@/lib/client/mutate";
import { api } from "@/lib/client/rpc";
import { useDictation } from "@/lib/client/dictation";
import { useAppState } from "@/features/app-shell";
import type { BotSummary, ChatSummary, MessageView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { skillOptions, skillQueryAt, type SkillOption } from "../skill-options";
import { useDraft } from "../use-draft";
import { useUploads } from "../use-uploads";
import { MentionMenu } from "./mention-menu";
import { SkillMenu } from "./skill-menu";

/** The message box's id, so a page that just opened a chat can put focus in it. */
export const COMPOSER_INPUT_ID = "composer-input";

export interface ComposerHandle {
  addFiles: (files: FileList | File[]) => void;
  focus: () => void;
  setDraft: (text: string) => void;
}

/** The run going on in the chat, if any, and what it is waiting for. */
export interface ComposerRun {
  id: string;
  botName: string;
  status: RunStatus;
  waitingFor: "approval" | "takeover" | null;
}

export function Composer({
  chat,
  members,
  activeRun,
  computerOnline = true,
  onSent,
  ref,
}: {
  chat: ChatSummary;
  members: BotSummary[];
  activeRun: ComposerRun | null;
  computerOnline?: boolean;
  onSent: (message: MessageView) => void;
  ref?: Ref<ComposerHandle>;
}) {
  const [text, setText] = useDraft(chat.id);
  const { uploads, addFiles, ready, remove, clear } = useUploads();
  const [mentioning, setMentioning] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const { data: state } = useAppState();
  const [sending, startSending] = useTransition();
  const [stopping, startStopping] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const failedSend = useRef<SendAttempt | null>(null);
  const dictation = useDictation({
    onText: setText,
    onError: (message) => toast.error("Couldn't dictate", { description: message }),
  });
  const isGroup = chat.kind === "group";

  // Grow with the text, up to a limit.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [text]);

  useImperativeHandle(
    ref,
    () => ({
      addFiles,
      focus: () => textarea.current?.focus(),
      setDraft: (draft: string) => {
        setText(draft);
        requestAnimationFrame(() => textarea.current?.focus());
      },
    }),
    [addFiles, setText],
  );

  const mentionable = useMemo(
    () => (isGroup && mentioning !== null ? mentionOptions(members, mentioning) : []),
    [isGroup, mentioning, members],
  );

  const skills = useMemo(
    () => (skillQuery === null ? [] : skillOptions(skillQuery, members, state?.skills ?? [])),
    [skillQuery, members, state?.skills],
  );

  const menuSize = mentionable.length || skills.length;

  function updateMenus(value: string, caret: number) {
    setMentioning(isGroup ? mentionQuery(value, caret) : null);
    setSkillQuery(skillQueryAt(value, caret));
    setMenuIndex(0);
  }

  /** Replace text in place and put the caret right after it, before the next keystroke lands. */
  function replaceText(before: string, after: string) {
    const element = textarea.current;
    if (!element) return;
    flushSync(() => {
      setText(before + after);
      setMentioning(null);
      setSkillQuery(null);
    });
    element.focus();
    element.setSelectionRange(before.length, before.length);
  }

  function replaceBeforeCaret(pattern: RegExp, replacement: string) {
    const caret = textarea.current?.selectionStart ?? text.length;
    replaceText(text.slice(0, caret).replace(pattern, replacement), text.slice(caret));
  }

  function pickMention(member: BotSummary) {
    const caret = textarea.current?.selectionStart ?? text.length;
    const next = insertMention(text, caret, member);
    replaceText(next.text.slice(0, next.caret), next.text.slice(next.caret));
  }

  function insertSkill(skill: SkillOption) {
    replaceBeforeCaret(/\/([a-z0-9-]*)$/, `/${skill.name} `);
  }

  /** Start a skill from the toolbar: type the slash for you and open the menu. */
  function openSkills() {
    const caret = textarea.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const slash = before === "" || /\s$/.test(before) ? "/" : " /";
    replaceText(before + slash, text.slice(caret));
    setSkillQuery("");
    setMenuIndex(0);
  }

  function pick(index: number) {
    if (mentionable.length) pickMention(mentionable[index]!);
    else if (skills.length) insertSkill(skills[index]!);
  }

  const canSend = (text.trim().length > 0 || uploads.length > 0) && ready && !sending;

  function submit() {
    if (!canSend) return;
    const attachments = uploads.map((upload) => upload.attachment!).filter(Boolean);
    const mentions = isGroup ? mentionedIds(text, members) : [];
    const draft = text;
    // Sending the same message again after a failure reuses its id, so it's never saved twice.
    const thisSend = sendAttempt(failedSend.current, [chat.id, draft, attachments, mentions], () =>
      crypto.randomUUID(),
    );
    const { clientId } = thisSend;
    dictation.cancel();
    setText("");
    clear();
    startSending(async () => {
      const result = await attempt(
        api.chats.send({ clientId, chatId: chat.id, text: draft, attachments, mentions }),
      );
      if (!result.ok) {
        failedSend.current = thisSend;
        toast.error("Couldn't send", { description: result.error });
        setText(draft);
        return;
      }
      failedSend.current = null;
      onSent(result.data);
    });
  }

  // What the run is doing now: waiting on you, paused for the computer, or working.
  const waiting = activeRun?.status === "waiting";
  const paused = Boolean(activeRun) && !waiting && !computerOnline;
  const placeholder = activeRun
    ? waiting || paused
      ? `Add a note for ${activeRun.botName}…`
      : `Add to what ${activeRun.botName} is doing…`
    : isGroup
      ? "Message the group, or @ a teammate…"
      : `Message ${members[0]?.name ?? "your teammate"}…`;

  return (
    <div className="relative">
      {mentionable.length > 0 && (
        <MentionMenu
          options={mentionable}
          selected={menuIndex}
          onHover={setMenuIndex}
          onPick={pickMention}
        />
      )}
      {skillQuery !== null && mentionable.length === 0 && (
        <SkillMenu
          options={skills}
          members={members}
          selected={menuIndex}
          onHover={setMenuIndex}
          onPick={insertSkill}
        />
      )}
      <div
        className={cn(
          "flex flex-col rounded-[20px] border border-border/80 bg-card shadow-[0_1px_2px_rgb(16_17_22/0.04),0_10px_28px_-14px_rgb(16_17_22/0.14)] transition-[border-color,box-shadow] focus-within:border-foreground/20 focus-within:shadow-[0_1px_2px_rgb(16_17_22/0.05),0_14px_36px_-14px_rgb(16_17_22/0.2)] dark:shadow-none",
        )}
      >
        {activeRun && (waiting || paused) && (
          <div
            className={cn(
              "flex items-center gap-2 px-4 pt-3 text-[12.5px] font-medium",
              waiting ? "text-attention-ink" : "text-muted-foreground",
            )}
            data-testid="composer-run-state"
          >
            {waiting ? (
              activeRun.waitingFor === "takeover" ? (
                <Hand className="size-3.5 shrink-0" />
              ) : (
                <ShieldAlert className="size-3.5 shrink-0" />
              )
            ) : (
              <CloudOff className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {waiting
                ? activeRun.waitingFor === "takeover"
                  ? `${activeRun.botName} is waiting for you to take over`
                  : `${activeRun.botName} is waiting for your approval`
                : `${activeRun.botName}'s work is paused until the computer is back`}
            </span>
          </div>
        )}
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {uploads.map((upload) => (
              <span
                key={upload.id}
                className="flex max-w-[220px] items-center gap-2 rounded-lg border bg-subtle py-1.5 pr-1.5 pl-2.5 text-[12.5px]"
              >
                {upload.status === "uploading" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FileText className="size-3.5" />
                )}
                <span className="truncate">{upload.name}</span>
                {upload.attachment && (
                  <span className="text-muted-foreground">{fileSize(upload.attachment.size)}</span>
                )}
                <button
                  aria-label={`Remove ${upload.name}`}
                  onClick={() => remove(upload.id)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          value={text}
          rows={1}
          aria-label="Message"
          id={COMPOSER_INPUT_ID}
          data-testid="composer-input"
          placeholder={placeholder}
          onChange={(event) => {
            // Typing takes over from dictating, keeping what you said so far.
            dictation.cancel();
            setText(event.target.value);
            updateMenus(event.target.value, event.target.selectionStart);
          }}
          onBlur={() => {
            setMentioning(null);
            setSkillQuery(null);
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length) {
              event.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (mentioning !== null || skillQuery !== null) {
              if (event.key === "Escape") {
                event.preventDefault();
                setMentioning(null);
                setSkillQuery(null);
                return;
              }
            }
            if (menuSize > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMenuIndex((index) => (index + 1) % menuSize);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMenuIndex((index) => (index - 1 + menuSize) % menuSize);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                pick(menuIndex);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="max-h-60 min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14.5px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2 [&_button[data-variant=ghost]]:text-muted-foreground [&_button[data-variant=ghost]:hover]:text-foreground">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Attach files"
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach files (they go in the shared folder)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Use a skill"
                data-testid="open-skills"
                onMouseDown={(event) => event.preventDefault()}
                onClick={openSkills}
              >
                <Sparkles />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Use a skill (or type /)</TooltipContent>
          </Tooltip>
          {dictation.supported && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={dictation.listening ? "Stop dictating" : "Dictate"}
                  aria-pressed={dictation.listening}
                  data-testid="dictate"
                  className={cn(
                    dictation.listening &&
                      "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (dictation.listening) return dictation.stop();
                    dictation.start(text);
                    textarea.current?.focus();
                  }}
                >
                  {dictation.listening ? (
                    <span className="relative flex size-4 items-center justify-center">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/40" />
                      <Mic className="relative" />
                    </span>
                  ) : (
                    <Mic />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{dictation.listening ? "Stop dictating" : "Dictate"}</TooltipContent>
            </Tooltip>
          )}
          {dictation.listening && (
            <span className="pl-1 text-[12.5px] text-destructive" aria-live="polite">
              Listening…
            </span>
          )}
          <span className="flex-1" />
          {/* Stopping needs the computer. While it waits on you, stopping ends the whole task. */}
          {activeRun && computerOnline && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={waiting ? "ghost" : "outline"}
                  size="sm"
                  data-testid="stop-run"
                  disabled={stopping}
                  onClick={() =>
                    startStopping(async () => {
                      const result = await attempt(api.runs.cancel({ runId: activeRun.id }));
                      if (!result.ok) toast.error(result.error);
                    })
                  }
                >
                  {stopping ? (
                    <Loader2 className="animate-spin" />
                  ) : waiting ? null : (
                    <Square className="fill-current" />
                  )}
                  {waiting ? "Cancel task" : "Stop"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {waiting
                  ? `Cancel what ${activeRun.botName} is doing, instead of answering`
                  : `Stop ${activeRun.botName}`}
              </TooltipContent>
            </Tooltip>
          )}
          <Button
            size="icon"
            className="rounded-full"
            aria-label="Send"
            data-testid="send"
            disabled={!canSend}
            onClick={submit}
          >
            {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </div>
    </div>
  );
}
