let holders = 0;

/**
 * Counts the screens that hide themselves from screenshots: the first one to ask turns it on
 * (`prevent`), the last one to let go turns it off (`allow`). Returns the letting go, which only
 * counts once.
 */
export function holdScreenCapture(change: {
  prevent: () => unknown;
  allow: () => unknown;
}): () => void {
  holders += 1;
  if (holders === 1) void Promise.resolve(change.prevent()).catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) void Promise.resolve(change.allow()).catch(() => {});
  };
}
