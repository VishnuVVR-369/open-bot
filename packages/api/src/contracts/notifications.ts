import { z } from "zod";
import { base, id, ok } from "../base";
import { notificationViewSchema } from "../views";

export const notificationsContract = {
  /** The latest notifications, newest first. */
  list: base.output(z.array(notificationViewSchema)),
  /**
   * Mark these as read; or, with `through`, that one and every older one (the list shows only
   * the newest, so it's how "I've seen the list" reaches the ones below it, without touching
   * any that came in since); or all of them without either.
   */
  markRead: base
    .input(z.object({ ids: z.array(id).max(200).optional(), through: id.optional() }))
    .output(ok),
};
