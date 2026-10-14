import { SHAPES, type Shape } from './config.js';
export type Point = readonly [number, number];
const COUNT = 120;
function polygonRadius(vertices: Point[], x: number, y: number): number {
  let radius = Infinity;
  vertices.forEach((a, i) => {
    const b = vertices[(i + 1) % vertices.length]!;
    const ex = b[0] - a[0],
      ey = b[1] - a[1];
    const cross = x * ey - y * ex;
    if (Math.abs(cross) < 0.00001) return;
    const distance = (a[0] * ey - a[1] * ex) / cross;
    const segment = (a[0] * y - a[1] * x) / cross;
    if (distance >= 0 && segment >= -0.00001 && segment <= 1.00001)
      radius = Math.min(radius, distance);
  });
  return radius;
}
function outline(shape: Shape): Point[] {
  const result: Point[] = [];
  const vertices: Point[] = Array.from({ length: shape === 'star' ? 10 : 6 }, (_, i) => {
    const angle = -Math.PI / 2 + (i / (shape === 'star' ? 10 : 6)) * Math.PI * 2;
    const radius = shape === 'star' ? (i % 2 ? 25 : 45) : 42;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  for (let i = 0; i < COUNT; i++) {
    const angle = -Math.PI / 2 + (i / COUNT) * Math.PI * 2;
    const x = Math.cos(angle),
      y = Math.sin(angle);
    let radius = 39;
    if (shape === 'square') radius = 35 / (Math.abs(x) ** 7 + Math.abs(y) ** 7) ** (1 / 7);
    if (shape === 'star' || shape === 'hexagon') radius = polygonRadius(vertices, x, y);
    if (shape === 'cloud') {
      radius = Math.max(
        ...[
          [-29, 5, 16],
          [-15, -9, 19],
          [10, -13, 23],
          [28, 4, 16],
          [0, 8, 28],
        ].map(([cx, cy, r]) => {
          const projection = cx! * x + cy! * y;
          const discriminant = projection ** 2 - (cx! ** 2 + cy! ** 2 - r! ** 2);
          return discriminant < 0 ? 0 : projection + Math.sqrt(discriminant);
        }),
      );
      if (y > 0) radius = Math.min(radius, 25 / y);
    }
    if (shape === 'triangle') {
      // Radial intersection of three half-planes; rounded by the shared spline below.
      radius = Math.min(
        ...[
          [0, 1, 33],
          [0.8660254, -0.5, 23],
          [-0.8660254, -0.5, 23],
        ].map(([nx, ny, distance]) => {
          const dot = nx! * x + ny! * y;
          return dot > 0.0001 ? distance! / dot : Infinity;
        }),
      );
    }
    result.push([x * radius, y * radius]);
  }
  // Soften corners and cloud joins while preserving each silhouette.
  if (shape !== 'circle' && shape !== 'square')
    for (let pass = 0; pass < (shape === 'triangle' || shape === 'cloud' ? 3 : 1); pass++) {
      const copy = result.slice();
      for (let i = 0; i < COUNT; i++) {
        const prev = copy[(i + COUNT - 1) % COUNT]!,
          curr = copy[i]!,
          next = copy[(i + 1) % COUNT]!;
        result[i] = [(prev[0] + 2 * curr[0] + next[0]) / 4, (prev[1] + 2 * curr[1] + next[1]) / 4];
      }
    }
  return result;
}
const OUTLINES = SHAPES.map(outline);
const number = (n: number) => n.toFixed(2);
/** All shapes share the same topology, allowing continuous interruptible shape morphing. */
export function shapePath(weights: readonly number[]): string {
  const points = Array.from({ length: COUNT }, (_, i): Point => [
    OUTLINES.reduce((sum, points, s) => sum + points[i]![0] * weights[s]!, 0),
    OUTLINES.reduce((sum, points, s) => sum + points[i]![1] * weights[s]!, 0),
  ]);
  const first = points[0]!,
    last = points[COUNT - 1]!;
  let path = `M${number((first[0] + last[0]) / 2)},${number((first[1] + last[1]) / 2)}`;
  for (let i = 0; i < COUNT; i++) {
    const current = points[i]!,
      next = points[(i + 1) % COUNT]!;
    path += `Q${number(current[0])},${number(current[1])} ${number((current[0] + next[0]) / 2)},${number((current[1] + next[1]) / 2)}`;
  }
  return path + 'Z';
}
