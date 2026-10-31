import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { ComponentPropsWithoutRef } from "react";
import { Callout, Figure, SchemaMap, SectionCards } from "@/components/docs/content";
import * as diagrams from "@/components/docs/diagrams";
import { Sequence } from "@/components/docs/sequence";

function heading(Tag: "h2" | "h3" | "h4") {
  return function Heading({ id, children, ...props }: ComponentPropsWithoutRef<"h2">) {
    return (
      <Tag id={id} {...props}>
        {id ? (
          <a href={`#${id}`} className="anchor">
            {children}
          </a>
        ) : (
          children
        )}
      </Tag>
    );
  };
}

const components: MDXComponents = {
  h2: heading("h2"),
  h3: heading("h3"),
  h4: heading("h4"),
  // Links between docs pages navigate on the client.
  a: ({ href = "", ...props }) =>
    href.startsWith("/") ? <Link href={href} {...props} /> : <a href={href} {...props} />,
  table: (props) => (
    <div className="table-wrap">
      <table {...props} />
    </div>
  ),
  Callout,
  Figure,
  SchemaMap,
  SectionCards,
  Sequence,
  ...diagrams,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
