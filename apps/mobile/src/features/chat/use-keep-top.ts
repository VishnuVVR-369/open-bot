import { useEffect, useMemo, useRef, useState } from "react";
import type { KeepTop } from "@/features/chat/components/foldable-text";

/**
 * An opened message would grow from its bottom edge in the chat's inverted list. Pinning older rows
 * keeps its first line where you were reading: Android corrects the scroll natively, after layout
 * and before drawing. The pin must be on screen before the message opens and stay until the opened
 * message is, so each step waits for the commit before it to mount.
 * The pin names a native child of the list: the rows it has rendered, in order, then the footer.
 * Rows it has virtualized away leave no view, though a spacer might, so the pin goes two rendered
 * rows past the message, which is always an older row or the footer.
 *
 * Give `keepTop` to `KeepTopContext`, `rendered` to each `Row`, and `pinnedChild` to the list's
 * `maintainVisibleContentPosition`.
 */
export function useKeepTop() {
  const rendered = useRef(new Set<number>()).current;
  const [pin, setPin] = useState<{ child: number; open: () => void } | null>(null);
  useEffect(() => (pin ? afterMount(pin.open) : undefined), [pin]);
  const keepTop = useMemo<KeepTop>(
    () => ({
      open: (row, open) => {
        let before = 0;
        for (const index of rendered) if (index < row) before++;
        setPin({ child: Math.min(before + 2, rendered.size), open });
      },
      opened: () => void afterMount(() => setPin(null)),
    }),
    [rendered],
  );
  return { keepTop, rendered, pinnedChild: pin?.child ?? null };
}

/**
 * Runs `run` once everything React has committed so far is on screen. Android mounts a commit on
 * the next frame, and the second frame callback comes after that one. Returns a cancel.
 */
function afterMount(run: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(run);
  });
  return () => cancelAnimationFrame(frame);
}
