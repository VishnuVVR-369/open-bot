/**
 * What pages can load from /lib on their own origin, for the page skill and for tests. The files
 * themselves are assembled into dist/lib by scripts/build.mjs.
 */

export interface PageLibrary {
  name: string;
  /** What it's for, in a few words. */
  use: string;
  /** The tags that load it, in order. */
  tags: string[];
}

export const PAGE_KIT = {
  css: "/lib/kit@1/page.css",
  js: "/lib/kit@1/kit.js",
} as const;

export const PAGE_LIBRARIES: PageLibrary[] = [
  {
    name: "Mermaid 12",
    use: "diagrams: flowcharts, sequence, architecture, state, class, ER, timelines, mind maps",
    tags: ['<script src="/lib/mermaid@12/mermaid.min.js"></script>'],
  },
  {
    name: "Chart.js 4",
    use: "charts: bar, line, pie, doughnut, radar, scatter",
    tags: ['<script src="/lib/chart.js@4/chart.umd.min.js"></script>'],
  },
  {
    name: "D3 7",
    use: "custom visualizations and interactive SVG",
    tags: ['<script src="/lib/d3@7/d3.min.js"></script>'],
  },
  {
    name: "KaTeX 0.19",
    use: "math, written as $$…$$, \\[…\\] or \\(…\\)",
    tags: [
      '<link rel="stylesheet" href="/lib/katex@0.19/katex.min.css">',
      '<script src="/lib/katex@0.19/katex.min.js"></script>',
      '<script src="/lib/katex@0.19/auto-render.min.js"></script>',
    ],
  },
  {
    name: "highlight.js 11",
    use: 'syntax highlighting for <pre><code class="language-…"> (the kit colors it in both themes)',
    tags: ['<script src="/lib/highlight@11/highlight.min.js"></script>'],
  },
];
