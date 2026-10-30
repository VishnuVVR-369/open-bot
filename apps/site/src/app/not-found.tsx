import { Logo } from "@/components/icons";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-svh max-w-[1248px] flex-col justify-center px-5 sm:px-8">
      <a href="/" className="flex w-fit items-center gap-2.5 rounded-lg" aria-label="open-bot home">
        <Logo className="size-8" />
        <span className="font-display text-xl font-semibold tracking-[-0.02em]">open-bot</span>
      </a>
      <h1 className="mt-10 font-display text-[clamp(2.125rem,4.6vw,3.5rem)] leading-[1.02] font-semibold tracking-[-0.03em]">
        This page doesn&rsquo;t exist
        <span className="dot" aria-hidden />
      </h1>
      <p className="mt-5 text-lg text-graphite">
        <a
          href="/"
          className="font-medium text-ink underline decoration-rule decoration-2 underline-offset-4 hover:decoration-ink"
        >
          Go to the home page
        </a>
      </p>
    </main>
  );
}
