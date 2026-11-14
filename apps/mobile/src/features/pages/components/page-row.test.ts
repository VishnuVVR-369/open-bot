import type { PageSummary } from "@open-bot/api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pin: vi.fn() }));
vi.mock("expo-router", () => ({ router: {} }));
vi.mock("lucide-react-native", () => ({}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Pressable: "Pressable",
  View: "View",
}));
vi.mock("@/features/teammates/components/bot-avatar", () => ({})); // vocabulary: allow -- existing component path.
vi.mock("@/features/pages/components/page-thumb", () => ({}));
vi.mock("@/components/sheet", () => ({}));
vi.mock("@/components/text", () => ({}));
vi.mock("@/lib/api", () => ({ api: { pages: { pin: state.pin } } }));
vi.mock("@/lib/errors", () => ({ errorMessage: () => "Request failed" }));
vi.mock("@/lib/haptics", () => ({ haptics: { success: () => {} } }));
vi.mock("@/lib/motion", () => ({ animateLayout: () => {} }));
vi.mock("@/features/pages/pages", () => ({}));
vi.mock("@/lib/query", () => import("../../../lib/query"));
vi.mock("@/lib/time", () => ({}));
vi.mock("@/theme", () => ({ space: (value: number) => value, useColors: () => ({}) }));

import { queryClient, queryKeys } from "../../../lib/query";
import { setPagePinned } from "./page-row";

beforeEach(() => {
  queryClient.clear();
  state.pin.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => queryClient.clear());

it.each([true, false])(
  "refreshes page details after setting pinned=%s without an app event",
  async (pinned) => {
    const page = { id: "page-1", pinned: !pinned } as PageSummary;
    queryClient.setQueryData(queryKeys.pages, [page]);
    queryClient.setQueryData(queryKeys.page(page.id), page);
    queryClient.setQueryData(queryKeys.page("other-page"), { id: "other-page" });
    queryClient.setQueryData(queryKeys.pageLink("version-1", "light"), { url: "signed-link" });

    await setPagePinned(page, pinned);

    expect(state.pin).toHaveBeenCalledWith({ pageId: page.id, pinned });
    expect(queryClient.getQueryState(queryKeys.pages)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.page(page.id))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.page("other-page"))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.pageLink("version-1", "light"))?.isInvalidated).toBe(
      false,
    );
  },
);
