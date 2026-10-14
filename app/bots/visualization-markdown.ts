import { visualizationReferences } from "../../lib/bot-visualization-reference.mjs";
type Node = { type: string; value?: string; children?: Node[]; url?: string };
/** Only Markdown text nodes: examples in fenced/inline code stay literal. */
export function remarkVisualizations() {
  return (root: Node) => {
    function visit(node: Node) {
      if (!node.children || ["link", "linkReference"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const refs = visualizationReferences(child.value), parts: Node[] = []; let offset = 0;
        for (const ref of refs) {
          if (ref.start > offset) parts.push({ type: "text", value: child.value.slice(offset, ref.start) });
          parts.push(ref.path ? { type: "link", url: `bot-visualization:${encodeURIComponent(ref.path)}`, children: [{ type: "text", value: `Open visualization · ${ref.path.split("/").at(-1)}` }] }
            : { type: "text", value: "Visualization unavailable: unsupported reference." });
          offset = ref.end;
        }
        if (!refs.length) return [child];
        if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    }
    visit(root);
  };
}
