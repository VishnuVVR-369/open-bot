import { Logo, Wordmark } from "@/components/logo";

/** What the dark screen beside the form shows: teammates at work on the shared computer. */
const SCENE = [
  { name: "Iris", color: "#7C5CFF", line: "Comparing three flights to Lisbon" },
  { name: "Otto", color: "#14B8A6", line: "Fixed the failing checkout test" },
  { name: "Juno", color: "#F97316", line: "Drafted replies to 4 emails" },
];

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
          className="relative m-2 hidden w-[46%] max-w-[640px] flex-col justify-center overflow-hidden rounded-[14px] bg-bezel p-12 text-bezel-foreground lg:flex"
        >
          <div className="absolute inset-0 bg-[radial-gradient(rgb(255_255_255/0.06)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_70%_30%,black_10%,transparent_70%)] bg-[size:18px_18px]" />
          <div className="absolute -top-40 -right-40 size-[520px] rounded-full bg-[radial-gradient(closest-side,rgb(229_72_77/0.16),transparent)]" />
          <div className="relative flex flex-col gap-8">
            <Logo className="size-11 [&_.fill-foreground]:fill-white/[0.07] [&_.stroke-background]:stroke-white/80" />
            <p className="max-w-[22ch] font-heading text-[34px] leading-[1.1] font-semibold tracking-[-0.025em] text-white">
              Hand it off. They&rsquo;ll take it from here.
            </p>
            <ul className="flex flex-col gap-2">
              {SCENE.map((entry, index) => (
                <li
                  key={entry.name}
                  className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-3.5 py-3 ring-1 ring-white/[0.06]"
                >
                  <span
                    className="flex size-8 items-center justify-center rounded-[9px] font-heading text-[13px] font-semibold"
                    style={{
                      backgroundColor: `color-mix(in oklab, ${entry.color} 26%, transparent)`,
                      color: `color-mix(in oklab, ${entry.color} 55%, white)`,
                    }}
                  >
                    {entry.name[0]}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[13px] font-medium text-white/90">{entry.name}</span>
                    <span className="truncate text-[12.5px] text-white/55">{entry.line}</span>
                  </span>
                  {index === 0 ? (
                    <span className="size-2 animate-tally rounded-full bg-live" />
                  ) : (
                    <span className="size-2 rounded-full bg-done" />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
