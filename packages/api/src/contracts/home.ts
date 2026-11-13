import { z } from "zod";
import { base } from "../base";
import { appStateSchema, homeSchema } from "../home";

export const appContract = {
  /**
   * What the web app's shell shows on every screen: your team, chats, the computer, skills and
   * what needs you.
   */
  state: base.output(appStateSchema),
};

export const homeContract = {
  /**
   * What needs you, recent work, and (with `awaySince`, when you were last here) what
   * teammates finished while you were away.
   */
  get: base
    .input(z.object({ awaySince: z.string().datetime({ offset: true }).nullable() }))
    .output(homeSchema),
};
