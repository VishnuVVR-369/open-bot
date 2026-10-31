import type { ReactNode } from "react";

const sizes = {
  hero: "text-[clamp(2.75rem,7.4vw,5.75rem)] leading-[0.96] tracking-[-0.035em]",
  section: "text-[clamp(2.125rem,4.6vw,3.5rem)] leading-[1.02] tracking-[-0.03em]",
  chapter: "text-[clamp(2rem,3.4vw,2.875rem)] leading-[1.04] tracking-[-0.028em]",
};

/** A headline that ends on the red dot, like the tally light on the logo. */
export function Heading({
  children,
  as: Tag = "h2",
  size = "section",
  className = "",
}: {
  children: ReactNode;
  as?: "h1" | "h2";
  size?: keyof typeof sizes;
  className?: string;
}) {
  return (
    <Tag className={`font-display font-semibold text-balance ${sizes[size]} ${className}`}>
      {children}
      <span className="dot" aria-hidden />
    </Tag>
  );
}
