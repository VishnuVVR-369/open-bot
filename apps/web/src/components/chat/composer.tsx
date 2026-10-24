"use client";

import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@open-bot/shared";
import { ArrowUp, FileText, Loader2, Mic, Paperclip, Sparkles, Square, X } from "lucide-react";
import Link from "next/link";
import {
  useCallback,
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
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cancelRun, sendMessage, uploadAttachment } from "@/lib/actions";
import { useDictation } from "@/lib/client/dictation";
import { useAppState } from "@/lib/client/queries";
import type { BotSummary, ChatSummary, MessageView, SkillSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

type Attachment = MessageView["attachments"][number];

export interface ComposerHandle {
  addFiles: (files: FileList | File[]) => void;
  focus: () => void;
  setDraft: (text: string) => void;
}

interface Upload {
  id: string;
  name: string;
  status: "uploading" | "done";
  attachment?: Attachment;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Composer({
  chat,
  members,
  activeRun,
  onSent,
  ref,
}: {
  chat: ChatSummary;
  members: BotSummary[];
  activeRun: { id: string; botName: string } | null;
  onSent: (message: MessageView) => void;
  ref?: Ref<ComposerHandle>;
}) {
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const { data: state } = useAppState();
  const [sending, startSending] = useTransition();
  const [stopping, startStopping] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dictation = useDictation({
    onText: setText,
    onError: (message) => toast.error("Couldn't dictate", { description: message }),
  });
  const isGroup = chat.kind === "group";

  const draftKey = `open-bot:draft:${chat.id}`;
  useEffect(() => {
    setText(localStorage.getItem(draftKey) ?? "");
  }, [draftKey]);
  useEffect(() => {
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  }, [text, draftKey]);

  // Grow with the text, up to a limit.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [text]);

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(`Couldn't attach ${file.name}`, {
          description: `Files can be up to ${MAX_UPLOAD_LABEL}.`,
        });
        continue;
      }
      const id = crypto.randomUUID();
      setUploads((current) => [
        ...current,
        { id, name: file.name || "pasted-image.png", status: "uploading" },
      ]);
      const form = new FormData();
      form.set(
        "file",
        file.name ? file : new File([file], "pasted-image.png", { type: file.type }),
      );
      const failed = (reason: string) => {
        toast.error(`Couldn't attach ${file.name}`, { description: reason });
        setUploads((current) => current.filter((upload) => upload.id !== id));
      };
      uploadAttachment(form).then(
        (result) => {
          if (!result.ok) return failed(result.error);
          setUploads((current) =>
            current.map((upload) =>
              upload.id === id ? { ...upload, status: "done", attachment: result.data } : upload,
            ),
          );
        },
        // The request itself failed, like a dropped connection.
        () => failed("The upload didn't go through. Try again."),
      );
    }
  }, []);

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
    [addFiles],
  );

  const mentionOptions = useMemo(() => {
    if (!isGroup || mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    return members.filter((member) => member.name.toLowerCase().startsWith(query));
  }, [isGroup, mentionQuery, members]);

  /** Skills this chat's teammates can use: the shared ones and their own. */
  const skillOptions = useMemo(() => {
    if (skillQuery === null) return [];
    const memberIds = new Set(members.map((member) => member.id));
    const usable = (state?.skills ?? []).filter(
      (skill) => skill.botId === null || memberIds.has(skill.botId),
    );
    const query = skillQuery.toLowerCase();
    return usable
      .filter((skill) => skill.name.includes(query))
      .sort((a, b) => Number(!a.name.startsWith(query)) - Number(!b.name.startsWith(query)))
      .slice(0, 8);
  }, [skillQuery, members, state?.skills]);

  const menuSize = mentionOptions.length || skillOptions.length;

  function updateMenus(value: string, caret: number) {
    const before = value.slice(0, caret);
    const mention = isGroup ? /(^|\s)@([\w-]*)$/.exec(before) : null;
    const skill = /(^|\s)\/([a-z0-9-]*)$/.exec(before);
    setMentionQuery(mention ? mention[2]! : null);
    setSkillQuery(skill ? skill[2]! : null);
    setMenuIndex(0);
  }

  /** Replace text in place and put the caret right after it, before the next keystroke lands. */
  function replaceText(before: string, after: string) {
    const element = textarea.current;
    if (!element) return;
    flushSync(() => {
      setText(before + after);
      setMentionQuery(null);
      setSkillQuery(null);
    });
    element.focus();
    element.setSelectionRange(before.length, before.length);
  }

  function replaceBeforeCaret(pattern: RegExp, replacement: string) {
    const caret = textarea.current?.selectionStart ?? text.length;
    replaceText(text.slice(0, caret).replace(pattern, replacement), text.slice(caret));
  }

  function insertMention(member: BotSummary) {
    replaceBeforeCaret(/@([\w-]*)$/, `@${member.name} `);
  }

  function insertSkill(skill: SkillSummary) {
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
    if (mentionOptions.length) insertMention(mentionOptions[index]!);
    else if (skillOptions.length) insertSkill(skillOptions[index]!);
  }

  const ready = uploads.every((upload) => upload.status === "done");
  const canSend = (text.trim().length > 0 || uploads.length > 0) && ready && !sending;

  function submit() {
    if (!canSend) return;
    const attachments = uploads.map((upload) => upload.attachment!).filter(Boolean);
    const mentions = isGroup
      ? members
          .filter((member) => new RegExp(`(^|\\s)@${member.name}(\\b|$)`, "i").test(text))
          .map((member) => member.id)
      : [];
    const draft = text;
    dictation.cancel();
    setText("");
    setUploads([]);
    startSending(async () => {
      const result = await sendMessage({ chatId: chat.id, text: draft, attachments, mentions });
      if (!result.ok) {
        toast.error("Couldn't send", { description: result.error });
        setText(draft);
        return;
      }
      onSent(result.data);
    });
  }

  const placeholder = activeRun
    ? `Add to what ${activeRun.botName} is doing…`
    : isGroup
      ? "Message the group, or @ a teammate…"
      : `Message ${members[0]?.name ?? "your teammate"}…`;

  return (
    <div className="relative">
      {mentionOptions.length > 0 && (
        <div
          className="absolute bottom-full left-0 mb-2 w-64 overflow-hidden rounded-xl border bg-popover p-1 shadow-lg"
          role="listbox"
          aria-label="Teammates"
        >
          {mentionOptions.map((member, index) => (
            <button
              key={member.id}
              role="option"
              aria-selected={index === menuIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                insertMention(member);
              }}
              onMouseEnter={() => setMenuIndex(index)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
                index === menuIndex && "bg-muted",
              )}
            >
              <BotAvatar name={member.name} color={member.color} emoji={member.emoji} size="xs" />
              <span className="text-sm font-medium">{member.name}</span>
              <span className="truncate text-xs text-muted-foreground">{member.role}</span>
            </button>
          ))}
        </div>
      )}
      {skillQuery !== null && mentionOptions.length === 0 && (
        <div
          className="absolute bottom-full left-0 mb-2 w-[min(420px,100%)] overflow-hidden rounded-xl border bg-popover p-1 shadow-lg"
          role="listbox"
          aria-label="Skills"
          data-testid="skill-menu"
        >
          <div className="flex items-center justify-between px-2 pt-1 pb-1.5 text-[11.5px] font-medium tracking-wide text-muted-foreground uppercase">
            Skills
            <Link
              href="/skills"
              onMouseDown={(event) => event.preventDefault()}
              className="text-[12px] font-normal tracking-normal normal-case hover:text-foreground"
            >
              Manage
            </Link>
          </div>
          {skillOptions.length === 0 ? (
            <p className="px-2 pb-2 text-[13px] text-muted-foreground">
              {state?.skills.length
                ? "No skill matches that name."
                : "No skills yet. Save one on the Skills page, or ask a teammate to save a task as a skill."}
            </p>
          ) : (
            skillOptions.map((skill, index) => {
              const owner = skill.botId ? members.find((m) => m.id === skill.botId) : null;
              return (
                <button
                  key={skill.id}
                  role="option"
                  aria-selected={index === menuIndex}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertSkill(skill);
                  }}
                  onMouseEnter={() => setMenuIndex(index)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left",
                    index === menuIndex && "bg-muted",
                  )}
                >
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-[13px] font-medium">/{skill.name}</span>
                      {owner && (
                        <BotAvatar
                          name={owner.name}
                          color={owner.color}
                          emoji={owner.emoji}
                          size="xs"
                          className="scale-90"
                        />
                      )}
                    </span>
                    <span className="truncate text-[12.5px] text-muted-foreground">
                      {skill.description}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
      <div
        className={cn(
          "flex flex-col rounded-[20px] border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)] transition-colors focus-within:border-foreground/25",
        )}
      >
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
                  <span className="text-muted-foreground">
                    {formatSize(upload.attachment.size)}
                  </span>
                )}
                <button
                  aria-label={`Remove ${upload.name}`}
                  onClick={() => setUploads((current) => current.filter((u) => u.id !== upload.id))}
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
          data-testid="composer-input"
          placeholder={placeholder}
          onChange={(event) => {
            // Typing takes over from dictating, keeping what you said so far.
            dictation.cancel();
            setText(event.target.value);
            updateMenus(event.target.value, event.target.selectionStart);
          }}
          onBlur={() => {
            setMentionQuery(null);
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
            if (mentionQuery !== null || skillQuery !== null) {
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionQuery(null);
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
          className="max-h-60 min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14.5px] leading-relaxed outline-none placeholder:text-muted-foreground/80"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
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
          {activeRun && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="stop-run"
                  disabled={stopping}
                  onClick={() =>
                    startStopping(async () => {
                      const result = await cancelRun(activeRun.id);
                      if (!result.ok) toast.error(result.error);
                    })
                  }
                >
                  {stopping ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Square className="fill-current" />
                  )}
                  Stop
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop {activeRun.botName}</TooltipContent>
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
