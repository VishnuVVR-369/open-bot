"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

interface Heading {
  id: string;
  text: string;
  level: 2 | 3;
}

/**
 * "On this page": the article's h2 and h3 headings, with the one you're reading highlighted.
 * It reads the rendered headings, so it can never drift from the page's content.
 */
export function TableOfContents() {
  const pathname = usePathname();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const elements = [
      ...document.querySelectorAll<HTMLHeadingElement>("article.doc :is(h2, h3)[id]"),
    ];
    setHeadings(
      elements.map((element) => ({
        id: element.id,
        text: element.textContent ?? "",
        level: element.tagName === "H2" ? 2 : 3,
      })),
    );
    setActive(elements[0]?.id ?? null);
    if (elements.length === 0) return;

    // The active heading is the last one that scrolled past the top quarter of the window.
    const update = () => {
      const line = window.innerHeight * 0.25;
      let current = elements[0]!.id;
      for (const element of elements) {
        if (element.getBoundingClientRect().top <= line) current = element.id;
      }
      // At the very bottom, the last heading may never reach the line.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        current = elements.at(-1)!.id;
      }
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [pathname]);

  if (headings.length < 2) return null;
  return (
    <nav aria-label="On this page">
      <p className="mb-3 text-[0.75rem] font-semibold tracking-[0.08em] text-graphite uppercase">
        On this page
      </p>
      <ul className="space-y-1.5 border-l border-rule text-[0.875rem] leading-snug">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              className={`-ml-px block border-l py-0.5 transition-colors ${
                heading.level === 3 ? "pl-6" : "pl-3.5"
              } ${
                active === heading.id
                  ? "border-ink font-medium text-ink"
                  : "border-transparent text-graphite hover:text-ink"
              }`}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
