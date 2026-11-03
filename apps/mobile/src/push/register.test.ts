import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  initial: vi.fn(),
  push: vi.fn(),
  state: null as null | ((state: string) => void),
  cleanup: null as null | (() => void),
  remove: vi.fn(),
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
  },
  EventType: { PRESS: 1, ACTION_PRESS: 2 },
}));
vi.mock("expo-device", () => ({}));
vi.mock("expo-router", () => ({ router: { push: native.push } }));
vi.mock("./firebase", () => ({ hasFirebase: false }));
vi.mock("./notifications", () => ({
  ensureChannels: async () => {},
  handleNotificationEvent: vi.fn(),
  handlePushData: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/query", () => ({ queryClient: {}, queryKeys: {} }));

import { usePushNotifications } from "./register";

afterEach(() => {
  native.cleanup?.();
  vi.clearAllMocks();
});

describe("notification navigation", () => {
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
