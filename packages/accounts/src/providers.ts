import type { AccountProvider } from "@open-bot/domain";
import { google } from "./google";
import { notion } from "./notion";
import type { ProviderAdapter } from "./provider";

/** Every provider's adapter. A provider in shared's AUTH_PROVIDERS without one doesn't compile. */
export const PROVIDER_ADAPTERS: Readonly<Record<AccountProvider, ProviderAdapter>> = {
  google,
  notion,
};

export function providerAdapter(id: AccountProvider): ProviderAdapter {
  return PROVIDER_ADAPTERS[id];
}
