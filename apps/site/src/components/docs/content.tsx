import Link from "next/link";
import type { ReactNode } from "react";
import { docs } from "@/lib/docs";

/** A diagram or chart with its caption, on a sheet. Wide content scrolls sideways on phones. */
export function Figure({
  children,
  caption,
  minWidth = 600,
}: {
  children: ReactNode;
  caption?: ReactNode;
  /** Below this width the figure scrolls instead of shrinking its text. */
  minWidth?: number;
}) {
  return (
    <figure className="diagram mt-8 mb-2 rounded-2xl bg-sheet p-4 ring-1 ring-rule sm:p-6">
      <div className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
        <div style={{ minWidth }}>{children}</div>
      </div>
      {caption && (
        <figcaption className="mt-5 border-t border-rule pt-4 text-[0.9375rem] leading-relaxed text-graphite">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

const calloutTones = {
  note: { bar: "bg-ink/25", label: "Note" },
  why: { bar: "bg-ink", label: "Why it works this way" },
  warning: { bar: "bg-manual", label: "Watch out" },
  risk: { bar: "bg-live", label: "Known risk" },
} as const;

/** A short aside. Use it sparingly, for things a reader would otherwise miss. */
export function Callout({
  kind = "note",
  title,
  children,
}: {
  kind?: keyof typeof calloutTones;
  title?: string;
  children: ReactNode;
}) {
  const tone = calloutTones[kind];
  return (
    <aside className="callout relative mt-7 overflow-hidden rounded-xl bg-sheet py-4 pr-5 pl-6 ring-1 ring-rule [&>div>:first-child]:mt-0">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} />
      <p className="text-[0.8125rem] font-semibold tracking-[0.06em] text-graphite uppercase">
        {title ?? tone.label}
      </p>
      <div className="mt-1.5 text-[1rem] leading-relaxed [&_p]:mt-2">{children}</div>
    </aside>
  );
}

/** Links to every page of a docs section, with their descriptions. */
export function SectionCards({ section }: { section: string }) {
  const match = docs.find((entry) => entry.title === section);
  if (!match) throw new Error(`No docs section named ${section}`);
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2">
      {match.pages.map((page) => (
        <Link
          key={page.href}
          href={page.href}
          className="card block rounded-xl bg-sheet px-5 py-4 ring-1 ring-rule transition-shadow hover:ring-ink/30"
        >
          <span className="block font-medium">{page.title}</span>
          <span className="mt-1 block text-[0.9375rem] leading-snug text-graphite">
            {page.description}
          </span>
        </Link>
      ))}
    </div>
  );
}

/** A grid of tables grouped by what they're for: a map of the schema, not every column. */
export function SchemaMap({
  groups,
}: {
  groups: { title: string; tables: { name: string; note: string }[] }[];
}) {
  return (
    <div className="mt-8 grid gap-3 sm:grid-cols-2">
      {groups.map((group) => (
        <section key={group.title} className="rounded-xl bg-sheet p-4 ring-1 ring-rule">
          <h4 className="!mt-0 font-sans text-[0.8125rem] font-semibold tracking-[0.06em] text-graphite uppercase">
            {group.title}
          </h4>
          <dl className="mt-2.5 space-y-2">
            {group.tables.map((table) => (
              <div key={table.name} className="text-[0.9375rem] leading-snug">
                <dt className="font-mono text-[0.8125rem] font-medium">{table.name}</dt>
                <dd className="text-graphite">{table.note}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
