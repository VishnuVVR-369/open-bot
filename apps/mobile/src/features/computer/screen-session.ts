import type { ScreenState } from "./screens";

/** A screen request in flight: only one runs at a time. */
export type Pending = "wake" | "take-over" | "hand-back";

/**
 * What the owner is doing on a screen's page, apart from the screen itself: the request in flight,
 * the hand-back sheet and its note, the code sheet, and the remote keyboard (what's typed so far,
 * the trackpad switch and the modifier keys held down).
 */
export interface ScreenSession {
  pending: Pending | null;
  handBack: boolean;
  note: string;
  /** The takeover whose code sheet is mounted, and whether it is open. */
  code: { takeoverId: string | null; open: boolean };
  draft: string;
  trackpad: boolean;
  held: string[];
}

export type ScreenEvent =
  /** The page opened, or its link changed: show the code sheet the link asks for. */
  | { type: "link"; takeoverId: string | null; code: boolean }
  | { type: "start"; pending: Pending }
  | { type: "settle" }
  | { type: "ask-hand-back" }
  | { type: "cancel-hand-back" }
  | { type: "handed-back" }
  | { type: "note"; note: string }
  | { type: "open-code"; takeoverId: string }
  | { type: "close-code" }
  | { type: "typed"; draft: string }
  | { type: "toggle-trackpad" }
  /** A modifier key went down or came back up on the remote screen. */
  | { type: "hold"; code: string; down: boolean }
  /** The remote keyboard starts over: control changed hands, or the stream connected or dropped. */
  | { type: "input-reset" }
  /** The app locked: nothing typed or held survives, and the code sheet closes. */
  | { type: "access-lost" };

export function screenSession(link: { takeoverId: string | null; code: boolean }): ScreenSession {
  return {
    pending: null,
    handBack: false,
    note: "",
    code: { takeoverId: link.takeoverId, open: link.code },
    draft: "",
    trackpad: false,
    held: [],
  };
}

export function reduceScreenSession(state: ScreenSession, event: ScreenEvent): ScreenSession {
  switch (event.type) {
    case "link":
      return { ...state, code: { takeoverId: event.takeoverId, open: event.code } };
    case "start":
      return { ...state, pending: event.pending };
    case "settle":
      return { ...state, pending: null };
    case "ask-hand-back":
      return { ...state, handBack: true };
    case "cancel-hand-back":
      return { ...state, handBack: false };
    case "handed-back":
      return { ...state, handBack: false, note: "" };
    case "note":
      return { ...state, note: event.note };
    case "open-code":
      return { ...state, code: { takeoverId: event.takeoverId, open: true } };
    case "close-code":
      return { ...state, code: { takeoverId: null, open: false } };
    case "typed":
      return { ...state, draft: event.draft };
    case "toggle-trackpad":
      return { ...state, trackpad: !state.trackpad };
    case "hold":
      return {
        ...state,
        held: event.down
          ? [...state.held, event.code]
          : state.held.filter((code) => code !== event.code),
      };
    case "input-reset":
      return { ...state, trackpad: false, held: [], draft: "" };
    case "access-lost":
      return { ...state, code: { ...state.code, open: false }, draft: "", held: [] };
  }
}

/**
 * What to send when the remote keyboard's field changes from `before` to `after`: backspaces for
 * what was removed past the shared prefix, then the new text.
 */
export function typedChange(before: string, after: string) {
  let prefix = 0;
  while (prefix < after.length && prefix < before.length && after[prefix] === before[prefix])
    prefix++;
  return { backspaces: before.length - prefix, text: after.slice(prefix) };
}

export interface ScreenAction {
  kind: "hand-back" | "retry" | "take-over" | "wake";
  title: string;
  primary: boolean;
  testID: string;
}

/**
 * The page's actions: one main action, on the right where the thumb is, with at most one quieter
 * one beside it.
 */
export function screenActions(owner: boolean, state: ScreenState): ScreenAction[] {
  if (owner) return [{ kind: "hand-back", title: "Hand back", primary: true, testID: "hand-back" }];
  if (state.kind === "offline")
    return [{ kind: "retry", title: "Try again", primary: true, testID: "retry-screen" }];
  if (state.kind === "asleep")
    return [
      { kind: "take-over", title: "Take over", primary: false, testID: "take-over" },
      { kind: "wake", title: "Wake screen", primary: true, testID: "wake-screen" },
    ];
  return [{ kind: "take-over", title: "Take over", primary: true, testID: "take-over" }];
}
