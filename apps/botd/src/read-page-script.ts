/** Runs in the page: what a person sees on it, as text, and its links. */
export function readPageScript(selector?: string): string {
  return `(() => {
    if (document.visibilityState !== "visible") return { visible: false };
    let root;
    try {
      root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"};
    } catch {
      root = null;
    }
    if (!root) return { visible: true, missing: true };
    const seen = new Set();
    const links = [];
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.href;
      if (!/^https?:/.test(href) || seen.has(href)) continue;
      seen.add(href);
      links.push({ text: (a.innerText || a.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 200), href });
    }
    const text = (root.innerText || "").replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
    return { visible: true, url: location.href, title: document.title, text, links };
  })()`;
}
