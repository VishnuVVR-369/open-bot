import type { CSSProperties, ReactNode } from "react";

export interface Actor {
  id: string;
  label: string;
  /** A second line under the name, like the process or port. */
  sub?: string;
}

export type SequenceStep =
  /** A message from one participant to another. `reply` draws it dashed, as a response. */
  | { from: string; to: string; label: ReactNode; reply?: boolean }
  /** Work a participant does on its own. */
  | { self: string; label: ReactNode }
  /** Context that spans one or more participants. */
  | { note: ReactNode; over: string | [string, string] }
  /** A break in time, like "later, you approve". */
  | { section: string };

/**
 * A sequence diagram drawn with HTML and CSS: participants across the top, time running down.
 * Labels are real text, so they wrap and stay readable instead of shrinking with an SVG.
 * Messages and self steps are numbered, so the prose next to a diagram can refer to "step 4".
 */
export function Sequence({ actors, steps }: { actors: Actor[]; steps: SequenceStep[] }) {
  const columns = actors.length;
  const index = (id: string) => {
    const at = actors.findIndex((actor) => actor.id === id);
    if (at === -1) throw new Error(`Sequence: no participant "${id}"`);
    return at;
  };
  const grid: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
  };
  let number = 0;

  return (
    <div className="text-[0.8125rem] leading-snug" style={{ minWidth: columns * 116 }}>
      <div style={grid} className="gap-x-2">
        {actors.map((actor) => (
          <div key={actor.id} className="rounded-lg bg-ink px-2 py-2 text-center text-white">
            <div className="font-semibold">{actor.label}</div>
            {actor.sub && <div className="mt-0.5 text-[0.75rem] text-white/60">{actor.sub}</div>}
          </div>
        ))}
      </div>

      <div className="relative pt-2 pb-3">
        {/* Lifelines. */}
        {actors.map((actor, i) => (
          <span
            key={actor.id}
            aria-hidden
            className="absolute top-0 bottom-0 border-l border-dashed border-[#c5c9d1]"
            style={{ left: `${((i + 0.5) / columns) * 100}%` }}
          />
        ))}

        <ol className="relative !mt-0 !list-none !pl-0" style={grid}>
          {steps.map((step, key) => {
            if ("section" in step) {
              return (
                <li key={key} className="!mt-0 !p-0" style={{ gridColumn: "1 / -1" }}>
                  <div className="my-2.5 flex items-center gap-3">
                    <span className="h-px flex-1 bg-rule" />
                    <span className="rounded-full bg-paper px-3 py-1 text-[0.75rem] font-semibold tracking-[0.05em] text-graphite uppercase ring-1 ring-rule">
                      {step.section}
                    </span>
                    <span className="h-px flex-1 bg-rule" />
                  </div>
                </li>
              );
            }

            if ("note" in step) {
              const [a, b] = Array.isArray(step.over) ? step.over : [step.over, step.over];
              const lo = Math.min(index(a), index(b));
              const hi = Math.max(index(a), index(b));
              return (
                <li
                  key={key}
                  className="!mt-0 !p-0"
                  style={{ gridColumn: `${lo + 1} / ${hi + 2}` }}
                >
                  <div className="mx-1.5 my-1.5 rounded-md bg-[#f1f2f5] px-3 py-2 text-center text-graphite ring-1 ring-rule">
                    {step.note}
                  </div>
                </li>
              );
            }

            number += 1;
            if ("self" in step) {
              const at = index(step.self);
              return (
                <li
                  key={key}
                  className="!mt-0 !p-0"
                  style={{ gridColumn: `${at + 1} / ${at + 2}` }}
                >
                  <div className="mx-1.5 my-2 rounded-md bg-sheet px-2.5 py-2 text-center ring-1 ring-ink/70">
                    <StepNumber value={number} />
                    {step.label}
                  </div>
                </li>
              );
            }

            const from = index(step.from);
            const to = index(step.to);
            const lo = Math.min(from, to);
            const span = Math.abs(from - to) + 1;
            const inset = `${50 / span}%`;
            const rightward = to > from;
            return (
              <li
                key={key}
                className="!mt-0 !p-0"
                style={{ gridColumn: `${lo + 1} / span ${span}` }}
              >
                <div className="pt-2.5 pb-2" style={{ paddingLeft: inset, paddingRight: inset }}>
                  <div className="px-2 pb-1.5 text-center">
                    <span className="box-decoration-clone bg-sheet px-1">
                      <StepNumber value={number} />
                      {step.label}
                    </span>
                  </div>
                  <div className="relative">
                    <div
                      className={`border-t ${step.reply ? "border-dashed border-graphite" : "border-ink"}`}
                    />
                    <svg
                      viewBox="0 0 10 10"
                      aria-hidden
                      className={`absolute top-1/2 size-2.5 -translate-y-1/2 ${
                        rightward ? "-right-px" : "-left-px rotate-180"
                      } ${step.reply ? "text-graphite" : "text-ink"}`}
                    >
                      <path d="M1 1.2 9 5 1 8.8Z" fill="currentColor" />
                    </svg>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function StepNumber({ value }: { value: number }) {
  return (
    <span className="mr-1.5 inline-flex h-[1.125rem] min-w-[1.125rem] translate-y-[-1px] px-[0.1875rem] items-center justify-center rounded-full bg-ink align-middle font-mono text-[0.6875rem] leading-none font-semibold text-white">
      {value}
    </span>
  );
}
