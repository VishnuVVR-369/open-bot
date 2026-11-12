import type { ActionEffect } from "@open-bot/domain";

/**
 * The effect of a calendar change: anything that involves other people is outward, and so are
 * deleting (it can't be taken back from here) and answering invitations (the organizer hears).
 */
export function calendarEffect(
  tool: "create_event" | "update_event" | "delete_event" | "respond",
  guests: { before: string[]; after: string[] },
  self: string,
): ActionEffect {
  if (tool === "delete_event" || tool === "respond") return "outward";
  return others([...guests.before, ...guests.after], self).length > 0 ? "outward" : "write";
}

function others(guests: string[], self: string): string[] {
  const me = self.toLowerCase();
  return guests.filter((guest) => guest.toLowerCase() !== me);
}
