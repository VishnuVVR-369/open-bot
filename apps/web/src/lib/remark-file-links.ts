import { COMPUTER_FILE_PATH } from "@/lib/files";

/** The parts of a Markdown tree this plugin touches. */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

/** Nodes whose text is never turned into links. */
const SKIP = new Set(["link", "linkReference", "code", "html", "definition"]);

function link(path: string): Node {
  return { type: "link", url: path, children: [{ type: "text", value: path }] };
}

function splitText(value: string): Node[] | null {
  const nodes: Node[] = [];
  let last = 0;
  for (const match of value.matchAll(COMPUTER_FILE_PATH)) {
    if (match.index > last) nodes.push({ type: "text", value: value.slice(last, match.index) });
    nodes.push(link(match[0]));
    last = match.index + match[0].length;
  }
  if (last === 0) return null;
  if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
  return nodes;
}

function isWholePath(value: string): boolean {
  const matches = [...value.matchAll(COMPUTER_FILE_PATH)];
  return matches.length === 1 && matches[0]![0] === value.trim();
}

function walk(node: Node) {
  if (!node.children || SKIP.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value) return splitText(child.value) ?? [child];
    // `/home/bot/shared/report.md` in code is a file too, when it's only the path.
    if (child.type === "inlineCode" && child.value && isWholePath(child.value))
      return [link(child.value.trim())];
    walk(child);
    return [child];
  });
}

/**
 * Turns paths to files on the computer, like /home/bot/shared/report.md, into links, so a
 * teammate's reply can open the file right in the app.
 */
export function remarkFileLinks() {
  return (tree: Node) => walk(tree);
}
