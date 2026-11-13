import type { Metadata } from "next";
import { Page } from "@/components/page";
import { VaultView } from "@/features/vault";

export const metadata: Metadata = { title: "Vault" };

export default function VaultPage() {
  return (
    <Page
      title="Vault"
      description="Logins and cards your teammates fill in on the computer, without ever seeing them."
    >
      <VaultView />
    </Page>
  );
}
