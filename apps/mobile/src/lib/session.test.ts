import { afterEach, describe, expect, it, vi } from "vitest";

const phone = vi.hoisted(() => ({
  /** What signing out did, in order. */
  calls: [] as string[],
  /** Whether the phone holds a sign-in (`RunProgress.signedIn()`). */
  holds: true,
  deps: [] as unknown[],
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  // Runs the effect when its dependencies change, as React does.
  useEffect: (effect: () => void, deps: unknown[]) => {
    if (deps.some((dep, i) => !Object.is(dep, phone.deps[i])) || !phone.deps.length) effect();
    phone.deps = deps;
  },
}));
vi.mock("@/push/register", () => ({
  holdsSignIn: () => phone.holds,
  forgetRunProgress: () => {
    phone.calls.push("forget run progress");
    phone.holds = false;
  },
  unregisterPushNotifications: async () => void phone.calls.push("unregister"),
}));
vi.mock("./auth", () => ({
  authClient: { signOut: async () => void phone.calls.push("end session") },
}));
vi.mock("./phone-egress", () => ({
  releasePhoneConnection: async () => void phone.calls.push("release phone connection"),
  signingOutDuring: (work: () => Promise<void>) => work(),
}));
vi.mock("./presence", () => ({ clearPresence: async () => void phone.calls.push("presence") }));
vi.mock("./query", () => ({ queryClient: { clear: () => void phone.calls.push("clear") } }));

import { sessionEnded, signOut, useSignOutWhenSessionEnds, type SessionState } from "./session";

const signedIn: SessionState = { data: { session: { id: "s1" } }, isPending: false, error: null };
const loading: SessionState = { data: null, isPending: true, error: null };
/** The server answered: no session. */
const none: SessionState = { data: null, isPending: false, error: null };
const refused: SessionState = { data: null, isPending: false, error: { status: 401 } };
/** No answer: offline (a failed fetch has no status), or the server failed. */
const offline: SessionState = { data: null, isPending: false, error: {} };
const failed: SessionState = { data: null, isPending: false, error: { status: 503 } };

afterEach(() => {
  phone.calls.length = 0;
  phone.holds = true;
  phone.deps = [];
});

describe("sessionEnded", () => {
  it("is true only when the server says there is no session", () => {
    expect(sessionEnded(none)).toBe(true);
    expect(sessionEnded(refused)).toBe(true);
    for (const state of [signedIn, loading, offline, failed])
      expect(sessionEnded(state)).toBe(false);
    // Better Auth keeps the session it had while it can't check.
    expect(sessionEnded({ ...signedIn, error: { status: 503 } })).toBe(false);
  });
});

describe("a session that ends without this phone signing out", () => {
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("signs the phone out the same way as you do, run progress first", async () => {
    useSignOutWhenSessionEnds(signedIn);
    // The session expired, or was revoked on the web.
    useSignOutWhenSessionEnds(none);
    await settle();
    expect(phone.calls).toEqual([
      "forget run progress",
      "release phone connection",
      "unregister",
      "end session",
      "clear",
      "presence",
    ]);
  });

  it("signs out on a 401 too, and only once", async () => {
    useSignOutWhenSessionEnds(signedIn);
    useSignOutWhenSessionEnds(refused);
    useSignOutWhenSessionEnds({ ...refused });
    useSignOutWhenSessionEnds(none);
    await settle();
    expect(phone.calls.filter((call) => call === "forget run progress")).toHaveLength(1);
  });

  it("keeps everything while loading, offline or when the server fails", async () => {
    // The app starts offline, then the server fails, then the session comes back, then offline.
    useSignOutWhenSessionEnds(loading);
    useSignOutWhenSessionEnds(offline);
    useSignOutWhenSessionEnds(failed);
    useSignOutWhenSessionEnds(signedIn);
    useSignOutWhenSessionEnds(offline);
    await settle();
    expect(phone.calls).toEqual([]);
    expect(phone.holds).toBe(true);
  });

  it("does nothing for a phone that holds no sign-in, such as on the sign-in screen", async () => {
    phone.holds = false;
    useSignOutWhenSessionEnds(none);
    await settle();
    expect(phone.calls).toEqual([]);
  });
});

describe("signOut", () => {
  it("forgets run progress before the first wait, so a push or a new sign-in can't come between", () => {
    void signOut();
    expect(phone.calls).toEqual(["forget run progress", "release phone connection"]);
    expect(phone.holds).toBe(false);
  });
});
