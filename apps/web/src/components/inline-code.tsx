import { shellScript } from "@open-bot/shared";

/** Text with `backtick` spans shown as code, like approval titles. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/);
  return (
    <>
      {parts.map((part, index) =>
        /^`[^`\n]+`$/.test(part) ? (
          <code
            key={index}
            className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[0.9em] font-normal"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** An approval's detail, with commands shown as the script they run rather than the shell wrapper. */
export function approvalDetail(detail: string): string {
  return detail
    .split("\n")
    .map((line) => (line.startsWith("$ ") ? `$ ${shellScript(line.slice(2))}` : line))
    .join("\n");
}
