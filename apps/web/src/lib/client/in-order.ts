/**
 * Writes that must reach the server in the order you made them, like toggling a rating: each starts
 * once the one before it has finished, and its answer says whether a newer write came after it,
 * so only the newest one updates what you see.
 */
export function inOrder() {
  let tail: Promise<unknown> = Promise.resolve();
  let made = 0;
  return function write<T>(send: () => Promise<T>): Promise<{ value: T; newest: boolean }> {
    const ticket = ++made;
    const sent = tail.then(send);
    tail = sent.catch(() => {});
    return sent.then((value) => ({ value, newest: ticket === made }));
  };
}
