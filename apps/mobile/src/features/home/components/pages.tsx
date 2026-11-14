import type { BotSummary, PageSummary } from "@open-bot/api";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Card, Section } from "@/components/section";
import { PageMenu, PageRow } from "@/features/pages/components/page-row";
import { sortPages } from "@/features/pages/pages";
import { SeeAll } from "./see-all";

/** How many pages Home shows. */
const PAGES_ON_HOME = 3;

/** The latest pages teammates made, pinned ones first. */
export function Pages({ pages, teammates }: { pages: PageSummary[]; teammates: BotSummary[] }) {
  const [menuFor, setMenuFor] = useState<PageSummary | null>(null);
  const shown = useMemo(() => sortPages(pages).slice(0, PAGES_ON_HOME), [pages]);
  if (shown.length === 0) return null;
  return (
    <Section
      title="Pages"
      action={
        <SeeAll
          label={pages.length > PAGES_ON_HOME ? `All ${pages.length}` : "All pages"}
          onPress={() => router.navigate("/pages")}
          testID="all-pages"
        />
      }
    >
      <Card>
        {shown.map((page, index) => (
          <PageRow
            key={page.id}
            page={page}
            bot={teammates.find((teammate) => teammate.id === page.botId)}
            first={index === 0}
            onMenu={() => setMenuFor(page)}
          />
        ))}
      </Card>
      <PageMenu page={menuFor} onClose={() => setMenuFor(null)} />
    </Section>
  );
}
