"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import type { BetterAuthClientPlugin } from "better-auth/client";
import { createAuthClient } from "better-auth/react";
import type { passkeyReset } from "./server/passkey-reset";

/** Types the passkey-reset endpoints: `authClient.passkeyReset.status()` and `.setPassword()`. */
const passkeyResetClient = () =>
  ({
    id: "passkey-reset",
    $InferServerPlugin: {} as ReturnType<typeof passkeyReset>,
  }) satisfies BetterAuthClientPlugin;

export const authClient = createAuthClient({ plugins: [passkeyClient(), passkeyResetClient()] });
