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
  it("names its teammate under the new key and, for phones on the old build, the old one", () => {
    // The old build reads only `botId`. Without it, a Reply from a group chat's notification would
    // mention nobody and the group's lead would answer instead of Rex. Remove `botId` only in the
    // database-rename PR (V6), once the new phone build is installed.
    const { data } = nativeNotification(reply);
    expect(data.teammateId).toBe("rex");
    expect(data.botId).toBe("rex"); // vocabulary: allow
  });

  it("names no teammate when the notification has none", () => {
    const { data } = nativeNotification({ ...reply, kind: "cap_reached", teammateId: null });
    expect(data).not.toHaveProperty("teammateId");
    expect(data).not.toHaveProperty("botId"); // vocabulary: allow
  });
});
