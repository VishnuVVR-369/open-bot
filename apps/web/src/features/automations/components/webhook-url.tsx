"use client";

import { toast } from "sonner";

/** A webhook's full URL, on the address you opened the app at. */
export function webhookUrl(hookPath: string): string {
  return `${window.location.origin}${hookPath}`;
}

/** Whether the app is open on this machine only, so services on the internet can't call it. */
export function isLocalOrigin(): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(window.location.hostname);
}

export async function copyWebhookUrl(hookPath: string): Promise<void> {
  await navigator.clipboard.writeText(webhookUrl(hookPath));
  toast("Copied the webhook URL");
}
