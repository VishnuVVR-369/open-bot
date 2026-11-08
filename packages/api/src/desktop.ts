import { z } from "zod";

/**
 * What the desktop app (`apps/desktop`) gets from `GET /api/desktop/egress-token`, with its
 * signed-in session, before it opens the egress tunnel. The path stays a plain route because
 * installed apps already call it; this schema is what both sides agree on.
 */
export const desktopEgressTokenSchema = z.object({
  /** The worker's egress tunnel, like `wss://worker.example/egress/agent`. */
  url: z.string().url(),
  /** A short-lived token for it, sent as `?token=`. */
  token: z.string().min(1),
});
export type DesktopEgressToken = z.infer<typeof desktopEgressTokenSchema>;

/** The query naming the install: `?device=<id>&name=<name>`. Older apps send neither. */
export const DESKTOP_DEVICE_ID = /^[\w-]{8,64}$/;
