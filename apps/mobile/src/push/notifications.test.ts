import { beforeEach, describe, expect, it, vi } from "vitest";

const { displayed, cancel } = vi.hoisted(() => ({
  displayed: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@notifee/react-native", () => ({
  default: { getDisplayedNotifications: displayed, cancelDisplayedNotification: cancel },
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2 },
  AndroidStyle: {},
  EventType: {},
}));
vi.mock("react-native", () => ({ AppState: {} }));
vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/realtime", () => ({ visibleChat: {} }));
vi.mock("@/theme/colors", () => ({ palette: {} }));

import { clearChatNotifications } from "./notifications";

const shown = [
  { id: "reply-a", notification: { data: { chatId: "a" } } },
  { id: "reply-b", notification: { data: { chatId: "b" } } },
  { id: "approval-a", notification: { data: { chatId: "a", approvalId: "approval" } } },
];

beforeEach(() => {
  vi.clearAllMocks();
  displayed.mockResolvedValue(shown);
  cancel.mockResolvedValue(undefined);
});

describe("clearing displayed chat notifications", () => {
  it("clears replies for the visible chat and preserves approvals and other chats", async () => {
    await clearChatNotifications("a", () => true);
    expect(cancel.mock.calls).toEqual([["reply-a"]]);
  });

  it("keeps notifications if focus is lost while fetching displayed notifications", async () => {
    let resolve!: (value: typeof shown) => void;
    displayed.mockReturnValue(new Promise((done) => (resolve = done)));
    let visible = true;
    const pending = clearChatNotifications("a", () => visible);
    visible = false;
    resolve(shown);
    await pending;
    expect(cancel).not.toHaveBeenCalled();
  });
});
