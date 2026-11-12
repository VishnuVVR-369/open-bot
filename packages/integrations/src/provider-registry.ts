import type { AccountProvider } from "@open-bot/domain";
import type { IntegrationEndpoints } from "./core/endpoints";
import type { ProviderAdapter } from "./core/provider";
import { google } from "./providers/google/oauth";
import { notion } from "./providers/notion/oauth";

export type ProviderAdapters = Readonly<Record<AccountProvider, ProviderAdapter>>;

/**
 * Every provider's sign-in adapter, one line each, talking to these endpoints. A provider in
 * `AUTH_PROVIDERS` (`@open-bot/domain`) without one doesn't compile.
 */
export function providerAdapters(endpoints: IntegrationEndpoints): ProviderAdapters {
  return {
    google: google(endpoints),
    notion: notion(endpoints),
  };
}
