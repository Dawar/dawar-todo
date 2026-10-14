import type { RouteDiagram } from "./route-visualization";
type Value = string | Value[] | { [key: string]: Value };
/** Data-only literal reader for the retained v1 routing fragment. No eval/JS execution. */
function routeLiteral(source: string): Value {
  let pos = 0, nodes = 0;
  const space = () => { while (/\s/.test(source[pos] ?? "") && pos < source.length) pos++; };
  function string(): string {
    const quote = source[pos++]; let result = "";
    while (pos < source.length) {
      let char = source[pos++];
      if (char === quote) return result;
      if (char === "\\") {
        char = source[pos++];
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' };
        if (!(char in escapes)) throw Error("Unsupported literal escape");
        char = escapes[char];
      } else if (char === "\n" || char === "\r") throw Error("Invalid string");
      result += char;
      if (result.length > 4000) throw Error("Diagram text limit");
    }
    throw Error("Unfinished string");
  }
  function value(depth: number): Value {
    space(); if (++nodes > 2000 || depth > 6) throw Error("Diagram complexity limit");
    const char = source[pos];
    if (char === '"' || char === "'") return string();
    if (char !== "{" && char !== "[") throw Error("Only literal diagram data is supported");
    pos++; const array = char === "[", end = array ? "]" : "}";
    const object: Record<string, Value> = Object.create(null), list: Value[] = [];
    space();
    while (source[pos] !== end) {
      if (array) list.push(value(depth + 1));
      else {
        space(); let key: string;
        if (source[pos] === '"' || source[pos] === "'") key = string();
        else { const match = /^[a-zA-Z][a-zA-Z0-9_-]*/.exec(source.slice(pos)); if (!match) throw Error("Invalid diagram key"); key = match[0]; pos += key.length; }
        if (["__proto__", "constructor", "prototype"].includes(key) || Object.hasOwn(object, key)) throw Error("Invalid duplicate/key");
        space(); if (source[pos++] !== ":") throw Error("Invalid property"); object[key] = value(depth + 1);
      }
      space(); if (source[pos] === end) break;
      if (source[pos++] !== ",") throw Error("Invalid literal separator"); space();
    }
    if (source[pos++] !== end) throw Error("Unfinished literal");
    return array ? list : object;
  }
  const result = value(0); space();
  // The remaining script is never interpreted. The object must end as a declaration.
  if (source[pos] !== ";") throw Error("Not a standalone data declaration");
  return result;
}
function diagram(value: unknown, title: string): RouteDiagram {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid routes");
  const entries = Object.entries(value); if (!entries.length || entries.length > 12) throw Error("Diagram route limit");
  const routes = entries.map(([id, data]) => {
    if (!/^[a-z][a-z0-9_-]{0,40}$/i.test(id) || !data || typeof data !== "object" || Array.isArray(data)) throw Error("Invalid route");
    const route = data as Record<string, unknown>;
    if (Object.keys(route).some(key => !["label", "stages", "note"].includes(key)) || typeof route.note !== "string" || route.note.length > 4000 ||
        !Array.isArray(route.stages) || !route.stages.length || route.stages.length > 32) throw Error("Invalid stages");
    if (route.label !== undefined && (typeof route.label !== "string" || route.label.length > 160)) throw Error("Invalid label");
    const stages = route.stages.map(stage => {
      if (!Array.isArray(stage) || stage.length !== 5 || !["app", "native"].includes(stage[0]) || stage.some(field => typeof field !== "string" || field.length > 4000)) throw Error("Invalid stage");
      return stage as string[];
    });
    const labels: Record<string, string> = { queue: "Queue next", send: "Human Send", schedule: "Scheduled occurrence", peer: "Bot A → Bot B request", reply: "Bot B → Bot A reply" };
    return { id, label: route.label as string ?? labels[id] ?? id, stages, note: route.note };
  });
  return { title: title.slice(0, 200), routes };
}
/** Explicit JSON format + narrowly recognized retained route fragment; ordinary HTML stays static. */
export function readRouteDiagram(text: string): RouteDiagram | null {
  const json = /<script\b(?=[^>]*\btype=["']application\/json["'])(?=[^>]*\bdata-bot-visualization=["']routes-v1["'])[^>]*>([\s\S]*?)<\/script\s*>/i.exec(text);
  if (json) {
    if (json[1].length > 64000) throw Error("Diagram data limit");
    const value = JSON.parse(json[1]);
    if (value?.version !== 1 || typeof value.title !== "string") throw Error("Unsupported diagram version");
    return diagram(value.routes, value.title);
  }
  if (!/\bid=["']dawar-work-routing-v1["']/.test(text)) return null;
  const script = /<script\s*>([\s\S]*?)<\/script\s*>/i.exec(text)?.[1];
  const start = script && /\bconst\s+routes\s*=\s*/.exec(script);
  if (!script || !start || script.length > 64000) throw Error("Unsupported routing data");
  return diagram(routeLiteral(script.slice(start.index + start[0].length)), "Who owns the work?");
}
