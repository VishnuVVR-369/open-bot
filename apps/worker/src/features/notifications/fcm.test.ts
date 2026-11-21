import { describe, expect, it } from "vitest";
import type { NotificationEvent } from "../../context";
import { nativeNotification } from "./fcm";

const reply: NotificationEvent = {
  id: "n1",
  kind: "run_finished",
  title: "Rex replied",
  body: "Booked it.",
  teammateId: "rex",
  chatId: "group",
  runId: "r1",
};

describe("a phone notification", () => {
  it("names its teammate, so a Reply from a group chat's notification mentions them", () => {
    const { data } = nativeNotification(reply);
    expect(data.teammateId).toBe("rex");
  });

  it("names no teammate when the notification has none", () => {
    const { data } = nativeNotification({ ...reply, kind: "cap_reached", teammateId: null });
    expect(data).not.toHaveProperty("teammateId");
  });

  it("opens the phone connection when the phone didn't answer a wake", () => {
    const { data } = nativeNotification({
      ...reply,
      kind: "egress_unanswered",
      teammateId: null,
      chatId: null,
      runId: null,
    });
    expect(data.url).toBe("/phone-connection");
  });
});
