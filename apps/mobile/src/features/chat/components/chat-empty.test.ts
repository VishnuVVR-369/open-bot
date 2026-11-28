import { act, cloneElement, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: "View",
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("lucide-react-native", () => ({ Users: "Users" }));
vi.mock("@/features/teammates/components/teammate-avatar", () => ({
  TeammateAvatar: "TeammateAvatar",
}));
vi.mock("@/components/states", () => ({ Empty: "Empty" }));
vi.mock("@/theme", () => ({ useColors: () => ({ mutedForeground: "#888" }) }));

const { ChatEmpty } = await import("./chat-empty");

describe("an empty chat", () => {
  // The chat's list is inverted, and it turns its empty state back the right way up by handing
  // the element a style (and an onLayout) through cloneElement. Dropping them showed it upside down.
  it("takes the list's flip and layout, so it reads the right way up", () => {
    const flip = { transform: [{ scale: -1 }] };
    const onLayout = vi.fn();
    const element = createElement(ChatEmpty, { teammate: undefined, isGroup: true });
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(cloneElement(element, { style: flip, onLayout } as never));
    });
    const root = renderer!.root.findByType("View" as never);
    expect([root.props.style].flat(Infinity)).toContainEqual(flip);
    expect(root.props.onLayout).toBe(onLayout);
  });
});
