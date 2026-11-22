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
vi.mock("expo-device", () => ({}));
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
    reset: () => void native.calls.push("reset run progress"),
  },
}));

import { unregisterPushNotifications, usePushNotifications } from "./register";

afterEach(() => {
  native.cleanup?.();
  native.calls.length = 0;
  native.fcm = null;
  vi.clearAllMocks();
});

describe("run progress", () => {
  it("tells the native module which chat is on screen while signed in", () => {
    native.initial.mockResolvedValue(null);
    usePushNotifications(true);
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
  it("stops pushes before it removes run progress and what the phone kept to redraw it", async () => {
    native.fcm = {
      getMessaging: () => "messaging",
      getToken: async () => "token-1",
      deleteToken: async () => void native.calls.push("delete token"),
    };
    await unregisterPushNotifications();
    expect(native.calls).toEqual([
      "unregister token-1",
      "delete token",
      "cancel notifications",
      "reset run progress",
    ]);
  });

  it("removes run progress in a build without Firebase too", async () => {
    await unregisterPushNotifications();
    expect(native.calls).toEqual(["cancel notifications", "reset run progress"]);
  });
});

describe("notification navigation", () => {
  it("restores a cold Type the code action into its code sheet", async () => {
    native.initial.mockResolvedValue({
      notification: { id: "takeover-cold", data: { url: "/screens/b1?takeover=t1" } },
      pressAction: { id: "type-code" },
    });
    usePushNotifications(true);
    await vi.waitFor(() =>
      expect(native.push).toHaveBeenCalledWith("/screens/b1?takeover=t1&code=1"),
    );
  });
  it("opens a Review received after sign-in when an already mounted app resumes", async () => {
    native.initial.mockResolvedValue(null);
    usePushNotifications(true);
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
