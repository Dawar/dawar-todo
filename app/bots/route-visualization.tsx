import { useId, useState } from "react";
export type RouteDiagram = { title: string; routes: { id: string; label: string; stages: string[][]; note: string }[] };
export function RouteVisualization({ diagram }: { diagram: RouteDiagram }) {
  const id = useId(), [selected, setSelected] = useState(diagram.routes[0].id);
  const route = diagram.routes.find(route => route.id === selected) ?? diagram.routes[0];
  return <article className="bots-route-diagram" aria-label={diagram.title}>
    <h2>{diagram.title}</h2><label htmlFor={id}>Trace a delivery path</label>
    <select id={id} value={route.id} onChange={event => setSelected(event.target.value)}>{diagram.routes.map(route => <option key={route.id} value={route.id}>{route.label}</option>)}</select>
    <p className="bots-route-legend">DawarTodo · application steps &nbsp; / &nbsp; Codex · native execution</p>
    <ol>{route.stages.map(([owner, actor, title, detail, code], index) => <li key={index} className={owner === "native" ? "is-native" : ""}>
      <span>{actor}</span><div><strong>{index + 1}. {title}</strong><p>{detail}</p><code>{code}</code></div>
    </li>)}</ol><p aria-live="polite">{route.note}</p>
  </article>;
}
