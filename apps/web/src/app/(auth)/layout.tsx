import { Wordmark } from "@/components/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex h-full overflow-y-auto">
      <div className="m-auto flex w-full max-w-[400px] flex-col gap-10 px-6 py-16">
        <Wordmark />
        {children}
      </div>
    </main>
  );
}
