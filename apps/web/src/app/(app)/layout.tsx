import { Providers } from "@/components/app/providers";
import { Shell } from "@/components/app/shell";
import { getAppState } from "@/lib/server/queries";
import { requireUser } from "@/lib/server/session";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const initial = await getAppState({ name: user.name, email: user.email });
  return (
    <Providers initial={initial}>
      <Shell initial={initial}>{children}</Shell>
    </Providers>
  );
}
