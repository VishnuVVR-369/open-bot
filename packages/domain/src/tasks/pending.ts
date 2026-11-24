import { withTaskMoved, type BoardTask } from "./board";
import type { TaskPlacement, TaskStatus } from "./tasks";

/** A move sent to the server, shown on the board until the server's board has it. */
export interface PendingMove {
  key: number;
  taskId: string;
  status: TaskStatus;
  placement: TaskPlacement;
  /** When the server answered that it made the move; null while that answer is on its way. */
  madeAt: number | null;
}

/**
 * The moves a client has sent and the server hasn't shown back yet. The board a client draws is
 * the last one the server sent with these moves laid over it, so the board the server sent is
 * never edited by hand: a refused move just stops being laid over it, and nothing else that
 * changed meanwhile is undone, whether or not reading the board again works.
 *
 * It's a tiny external store (`subscribe` and `snapshot`, for React's `useSyncExternalStore`).
 */
export class PendingMoves {
  private moves: readonly PendingMove[] = [];
  private readonly listeners = new Set<() => void>();
  private next = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): readonly PendingMove[] => this.moves;

  /** A move on its way to the server: it shows at once. Its key settles it. */
  add(taskId: string, status: TaskStatus, placement: TaskPlacement): number {
    const key = ++this.next;
    this.set([...this.moves, { key, taskId, status, placement, madeAt: null }]);
    return key;
  }

  /** The server refused it, or never answered: it stops showing. */
  refused(key: number) {
    this.set(this.moves.filter((move) => move.key !== key));
  }

  /**
   * The server made it at `at`: it shows until a board the server sent after then, which has it.
   * Read the board again after this (cancelling a read already on its way, which can't have it).
   */
  made(key: number, at: number) {
    this.set(this.moves.map((move) => (move.key === key ? { ...move, madeAt: at } : move)));
  }

  /** A board the server sent at `at` arrived: the moves made before then are in it, so they go. */
  confirmed(at: number) {
    const left = this.moves.filter((move) => !settled(move, at));
    if (left.length !== this.moves.length) this.set(left);
  }

  private set(moves: readonly PendingMove[]) {
    this.moves = moves;
    for (const listener of this.listeners) listener();
  }
}

/**
 * The board read at `boardAt` has the move: the server made it before then. A board from the same
 * millisecond may have been read just before, so it doesn't count; laying a move over a board that
 * already has it changes nothing.
 */
const settled = (move: PendingMove, boardAt: number) =>
  move.madeAt !== null && move.madeAt < boardAt;

/**
 * The board to draw: the one the server sent at `boardAt`, with the moves it doesn't have yet laid
 * over it in the order they were made. A move whose task, or the task it goes next to, is no
 * longer there is skipped.
 */
export function withPendingMoves<T extends BoardTask>(
  board: readonly T[],
  moves: readonly PendingMove[],
  boardAt: number,
): T[] {
  let shown = [...board];
  for (const move of moves) {
    if (settled(move, boardAt)) continue;
    shown = withTaskMoved(shown, move.taskId, move.status, move.placement) ?? shown;
  }
  return shown;
}

/**
 * Sends a move with `send`, showing it meanwhile, and returns what `send` answered. A refusal
 * (`made` false, or `send` throwing) stops showing at once, before the caller says why; a move
 * made shows until the board read again has it. Either way the board is read again (`reread`,
 * which should cancel a read already on its way: it can't have the move).
 */
export async function sendMove<R>(
  pending: PendingMoves,
  move: Pick<PendingMove, "taskId" | "status" | "placement">,
  send: () => Promise<R>,
  made: (answer: R) => boolean,
  reread: () => unknown,
  now: () => number = Date.now,
): Promise<R> {
  const key = pending.add(move.taskId, move.status, move.placement);
  let answer: R;
  try {
    answer = await send();
  } catch (error) {
    pending.refused(key);
    void reread();
    throw error;
  }
  if (made(answer)) pending.made(key, now());
  else pending.refused(key);
  void reread();
  return answer;
}

/**
 * The id of each ask to start a task (`tasks.start`'s `startId`), kept until the ask goes
 * through. Trying again after a failure, or an answer that never came, sends the same id, so
 * the worker asks the teammate at most once; once it went through, asking again is a new ask.
 * Asking another owner is a new ask too.
 */
export class TaskStartKeys {
  private readonly keys = new Map<string, string>();

  constructor(private readonly newKey: () => string) {}

  /** The id for asking `ownerId` to start `taskId`. */
  for(taskId: string, ownerId: string): string {
    const name = `${taskId}:${ownerId}`;
    let key = this.keys.get(name);
    if (!key) {
      key = this.newKey();
      this.keys.set(name, key);
    }
    return key;
  }

  /** The ask went through. */
  done(taskId: string, ownerId: string) {
    this.keys.delete(`${taskId}:${ownerId}`);
  }
}
