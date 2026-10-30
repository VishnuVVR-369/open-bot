import { chapterEnd, chapters } from "@/lib/tour";

export const dynamic = "force-static";

function timestamp(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `00:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

/** The chapters the player shows while scrubbing, from the same list the page uses. */
export function GET() {
  const cues = chapters.map(
    (c, i) => `${timestamp(c.at)} --> ${timestamp(chapterEnd(i))}\n${c.title}`,
  );
  return new Response(`WEBVTT\n\n${cues.join("\n\n")}\n`, {
    headers: { "Content-Type": "text/vtt; charset=utf-8" },
  });
}
