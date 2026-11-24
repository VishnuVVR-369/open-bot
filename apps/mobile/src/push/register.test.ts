import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  initial: vi.fn(),
  push: vi.fn(),
  state: null as null | ((state: string) => void),
  cleanup: null as null | (() => void),
  remove: vi.fn(),
  visibleChat: vi.fn(),
  chatListener: null as null | ((chatId: string | null) => void),
  /** What sign-out did, in order. */
  calls: [] as string[],
  /** Firebase messaging, when the build has it. */
  fcm: null as null | Record<string, unknown>,
  network: null as null | ((state: { isConnected: boolean; isInternetReachable: boolean }) => void),
  /** The network when the app asks (`getNetworkStateAsync`); the listener only reports changes. */
  networkNow: { isConnected: true, isInternetReachable: true },
  /** What the server answers a registration with: the registration it stored, or an error. */
  stored: (registration: string): Promise<string | undefined> => Promise.resolve(registration),
  /** The sign-outs running, for `signOutsSettled`. */
  signOut: Promise.resolve() as Promise<void>,
}));
vi.mock("react", () => ({
  useEffect: (effect: () => () => void) => {
    native.cleanup = effect();
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.state = listener;
      return { remove: native.remove };
    },
  },
}));
vi.mock("@notifee/react-native", () => ({
  default: {
    requestPermission: async () => {},
    getInitialNotification: native.initial,
    onForegroundEvent: () => () => {},
    cancelAllNotifications: async () => void native.calls.push("cancel notifications"),
  },
  EventType: { PRESS: 1, ACTION_PRESS: 2 },
}));
vi.mock("expo-device", () => ({ modelName: "Pixel 9" }));
vi.mock("expo-network", () => ({
  addNetworkStateListener: (listener: typeof native.network) => {
    native.network = listener;
    return { remove: () => (native.network = null) };
  },
  getNetworkStateAsync: async () => native.networkNow,
}));
vi.mock("@/lib/phone-egress", () => ({ signOutsSettled: () => native.signOut }));
vi.mock("expo-router", () => ({ router: { push: native.push } }));
vi.mock("./firebase", () => ({ messaging: () => native.fcm }));
vi.mock("./notifications", () => ({
  ensureChannels: async () => {},
  handleNotificationEvent: vi.fn(),
  handlePushData: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    push: {
      unregisterDevice: async ({ token }: { token: string }) =>
        void native.calls.push(`unregister ${token}`),
      registerDevice: async (input: { token: string; registration: string }) => {
        native.calls.push(`register ${input.token} ${input.registration}`);
        return { ok: true, registration: await native.stored(input.registration) };
      },
    },
  },
}));
vi.mock("@/lib/query", () => ({ queryClient: {}, queryKeys: {} }));
vi.mock("@/lib/realtime", () => ({
  visibleChat: {
    get: () => "open-chat",
    subscribe: (listener: (chatId: string | null) => void) => {
      native.chatListener = listener;
      return () => (native.chatListener = null);
    },
  },
}));
vi.mock("../../modules/run-progress", () => ({
  default: {
    setVisibleChat: native.visibleChat,
    registration: (sessionId: string) => {
      native.calls.push(`registration ${sessionId}`);
      return `reg-${sessionId}`;
    },
    reset: () => void native.calls.push("reset run progress"),
  },
}));

import { unregisterPushNotifications, usePushNotifications } from "./register";

afterEach(() => {
  native.cleanup?.();
  native.calls.length = 0;
  native.fcm = null;
  native.stored = (registration) => Promise.resolve(registration);
  native.signOut = Promise.resolve();
  native.networkNow = { isConnected: true, isInternetReachable: true };
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("run progress", () => {
  it("tells the native module which chat is on screen while signed in", () => {
    native.initial.mockResolvedValue(null);
    usePushNotifications("s1");
    expect(native.visibleChat).toHaveBeenCalledWith("open-chat");
    native.chatListener!(null);
    native.chatListener!("other");
    expect(native.visibleChat.mock.calls).toEqual([["open-chat"], [null], ["other"]]);
    native.cleanup!();
    native.cleanup = null;
    expect(native.chatListener).toBeNull();
  });
});

describe("sign-out", () => {
  it("forgets this sign-in's run progress before anything else, then stops pushes", async () => {
    native.fcm = {
      getMessaging: () => "messaging",
      getToken: async () => "token-1",
      deleteToken: async () => void native.calls.push("delete token"),
    };
    await unregisterPushNotifications();
    expect(native.calls).toEqual([
      "reset run progress",
      "unregister token-1",
      "delete token",
      "cancel notifications",
    ]);
  });

  it("removes run progress in a build without Firebase too", async () => {
    await unregisterPushNotifications();
    expect(native.calls).toEqual(["reset run progress", "cancel notifications"]);
  });
});

describe("registration", () => {
  let token = "token-1";
  let refresh!: () => void;
  const firebase = () => {
    token = "token-1";
    native.fcm = {
      getMessaging: () => "messaging",
      getToken: async () => token,
      onTokenRefresh: (_instance: unknown, listener: () => void) => {
        refresh = listener;
        return () => {};
      },
      onMessage: () => () => {},
    };
  };
  const registrations = () => native.calls.filter((call) => call.startsWith("register "));

  it("registers the token with this session's registration, taken before any push can carry it", async () => {
    native.initial.mockResolvedValue(null);
    firebase();
    usePushNotifications("s1");
    await vi.waitFor(() => expect(registrations()).toEqual(["register token-1 reg-s1"]));
    expect(native.calls[0]).toBe("registration s1");
    // A new token: registered again, with the same sign-in.
    token = "token-2";
    refresh();
    await vi.waitFor(() =>
      expect(registrations()).toEqual(["register token-1 reg-s1", "register token-2 reg-s1"]),
    );
  });

  it("waits for a sign-out still tearing down the sign-in before", async () => {
    native.initial.mockResolvedValue(null);
    firebase();
    let finish!: () => void;
    native.signOut = new Promise((done) => (finish = done));
    usePushNotifications("s2");
    await new Promise((done) => setTimeout(done, 10));
    // Nothing of the new sign-in yet: the old one's reset can't undo it.
    expect(native.calls).toEqual([]);
    finish();
    await vi.waitFor(() =>
      expect(native.calls).toEqual(["registration s2", "register token-1 reg-s2"]),
    );
  });

  it("tries a failed registration again, and again on resume and when back online", async () => {
    vi.useFakeTimers();
    native.initial.mockResolvedValue(null);
    firebase();
    // The server is down after an upgrade.
    native.stored = () => Promise.reject(new Error("503"));
    usePushNotifications("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(registrations()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(registrations()).toHaveLength(2);
    // Offline, then back: tried at once, with a fresh set of tries.
    native.network!({ isConnected: false, isInternetReachable: false });
    native.network!({ isConnected: true, isInternetReachable: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(registrations()).toHaveLength(3);
    // A server that answers without storing it (one older than this app) counts as failed too.
    native.stored = () => Promise.resolve(undefined);
    native.state!("active");
    await vi.advanceTimersByTimeAsync(0);
    expect(registrations()).toHaveLength(4);
    native.stored = (registration) => Promise.resolve(registration);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(registrations()).toHaveLength(5);
    // Stored: back on screen, nothing to send.
    native.state!("active");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(registrations()).toHaveLength(5);
  });

  it("tries again when back online in an app that started offline", async () => {
    vi.useFakeTimers();
    native.initial.mockResolvedValue(null);
    firebase();
    // Opened in airplane mode: the listener never hears of going offline, only of coming back.
    native.networkNow = { isConnected: false, isInternetReachable: false };
    native.stored = () => Promise.reject(new Error("offline"));
    usePushNotifications("s1");
    // Every try fails while offline, until none is left.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(registrations()).toHaveLength(4);
    native.stored = (registration) => Promise.resolve(registration);
    native.network!({ isConnected: true, isInternetReachable: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(registrations()).toHaveLength(5);
  });

  it("registers nothing after sign-out, not even a retry that was waiting or a new token", async () => {
    vi.useFakeTimers();
    native.initial.mockResolvedValue(null);
    firebase();
    native.stored = () => Promise.reject(new Error("offline"));
    usePushNotifications("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(registrations()).toHaveLength(1);
    native.cleanup!();
    native.cleanup = null;
    token = "token-2";
    refresh();
    native.state?.("active");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(registrations()).toHaveLength(1);
  });

  it("takes no registration for a sign-in that ended while a sign-out ran", async () => {
    native.initial.mockResolvedValue(null);
    firebase();
    let finish!: () => void;
    native.signOut = new Promise((done) => (finish = done));
    usePushNotifications("s1");
    native.cleanup!();
    native.cleanup = null;
    finish();
    await new Promise((done) => setTimeout(done, 10));
    expect(native.calls).toEqual([]);
  });
});

describe("notification navigation", () => {
  it("restores a cold Type the code action into its code sheet", async () => {
    native.initial.mockResolvedValue({
      notification: { id: "takeover-cold", data: { url: "/screens/b1?takeover=t1" } },
      pressAction: { id: "type-code" },
    });
    usePushNotifications("s1");
    await vi.waitFor(() =>
      expect(native.push).toHaveBeenCalledWith("/screens/b1?takeover=t1&code=1"),
    );
  });
  it("opens a Review received after sign-in when an already mounted app resumes", async () => {
    native.initial.mockResolvedValue(null);
    usePushNotifications("s1");
    await vi.waitFor(() => expect(native.initial).toHaveBeenCalledOnce());
    expect(native.push).not.toHaveBeenCalled();

    native.initial.mockResolvedValue({
      notification: { id: "purchase-resume", data: { url: "/approvals/purchase-1" } },
    });
    native.state!("active");
    await vi.waitFor(() => expect(native.push).toHaveBeenCalledWith("/approvals/purchase-1"));
    native.state!("active");
    await vi.waitFor(() => expect(native.initial).toHaveBeenCalledTimes(3));
    expect(native.push).toHaveBeenCalledOnce();
  });
});
