import { TEAMMATE_COLORS, TEAMMATE_TEMPLATES } from "@open-bot/domain";
import { Check } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { Logo, Wordmark } from "@/components/logo";

/**
 * What the dark screen beside the form shows: teammates from the real templates at work, one in
 * each state the app shows, in the app's own status colors.
 */
const SCENE: {
  template: string;
  color: string;
  line: string;
  state: "working" | "waiting" | "done";
}[] = [
  {
    template: "travel",
    color: TEAMMATE_COLORS[1],
    line: "Comparing three flights to Lisbon",
    state: "working",
  },
  {
    template: "chief-of-staff",
    color: TEAMMATE_COLORS[0],
    line: "Needs your approval to book the 9:40 flight",
    state: "waiting",
  },
  {
    template: "developer",
    color: TEAMMATE_COLORS[3],
    line: "Fixed the failing checkout test",
    state: "done",
  },
];

const STATE_LABEL = { working: "Working", waiting: "Needs you", done: "Done" } as const;

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex h-full overflow-y-auto bg-background p-2">
      <div className="flex min-h-full w-full flex-1 overflow-hidden rounded-[18px] bg-surface shadow-canvas">
        <div className="flex min-w-0 flex-1 flex-col px-6 py-8 sm:px-12">
          <Wordmark />
          <div className="mx-auto my-auto flex w-full max-w-[380px] flex-col gap-9 py-12">
            {children}
          </div>
          <p className="text-[12.5px] text-faint">Your AI teammates and the computer they share.</p>
        </div>
        <aside
          aria-hidden
          // Flush with the sheet's edges, like the form side: the sheet's own corners round it.
          className="relative hidden w-[46%] max-w-[640px] flex-col justify-center overflow-hidden bg-bezel p-14 text-bezel-foreground lg:flex"
        >
          <div className="absolute inset-0 bg-[radial-gradient(rgb(255_255_255/0.06)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_70%_30%,black_10%,transparent_70%)] bg-[size:18px_18px]" />
          <div className="absolute -top-40 -right-40 size-[520px] rounded-full bg-[radial-gradient(closest-side,rgb(255_255_255/0.07),transparent)]" />
          <div className="relative flex flex-col gap-8">
            <Logo className="size-11 [&_.fill-foreground]:fill-white/[0.07] [&_.stroke-background]:stroke-white/80" />
            <p className="max-w-[22ch] font-heading text-[34px] leading-[1.1] font-semibold tracking-[-0.025em] text-white">
              Hand it off. They&rsquo;ll take it from here.
            </p>
            {/* Avatars here sit on the dark screen whatever the theme, so they get dark tiles. */}
            <ul className="flex flex-col gap-2 [--avatar-ring:#1a1b20] [--foreground:#ffffff] [--surface:#1a1b20]">
              {SCENE.map((entry) => {
                const template = TEAMMATE_TEMPLATES.find((item) => item.id === entry.template)!;
                return (
                  <li
                    key={entry.template}
                    className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-3.5 py-3 ring-1 ring-white/[0.06]"
                  >
                    <BotAvatar
                      name={template.name}
                      color={entry.color}
                      emoji={template.emoji}
                      size="sm"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[13px] font-medium text-white/90">{template.name}</span>
                      <span className="truncate text-[12.5px] text-white/60">{entry.line}</span>
                    </span>
                    <span
                      className={
                        entry.state === "waiting"
                          ? "flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-attention"
                          : "flex shrink-0 items-center gap-1.5 text-[12px] text-white/55"
                      }
                    >
                      {entry.state === "done" ? (
                        <Check className="size-3.5 text-done" />
                      ) : entry.state === "working" ? (
                        <span className="size-1.5 animate-tally rounded-full bg-working" />
                      ) : (
                        <span className="size-1.5 rounded-full bg-attention" />
                      )}
                      {STATE_LABEL[entry.state]}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
