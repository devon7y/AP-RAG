// The AP-RAG mark — the seven-edge node star from the app icon, flattened for
// interface use: one colour taken from `currentColor`, no gradient, no edge
// shading, no cast shadow. The icon's modelling is meaningless at 13px and only
// muddies the shape, so the UI wears the outline of the same mark rather than a
// shrunken copy of the icon.
//
// Geometry is identical to desktop/build/icon.svg. Stroke weights are the only
// departure: scaled up 15% because these render at 10–14px, where the icon's
// hairlines fall below half a pixel and fade. The crown-to-foot taper is
// preserved.

const NODES: [number, number, number][] = [
  [32, 6.5, 6],
  [51.94, 16.1, 5.6],
  [12.06, 16.1, 5.6],
  [56.86, 37.67, 4.8],
  [7.14, 37.67, 4.8],
  [43.06, 54.97, 4.2],
  [20.94, 54.97, 4.2],
  [32, 32, 6.6],
];

const SPOKES: [string, number][] = [
  ["M32,32 L36.34,21.56 Q37.3,19.25 36.34,16.94 L32,6.5", 5.05],
  ["M32,32 L42.87,28.88 Q45.27,28.19 46.48,26 L51.94,16.1", 4.7],
  ["M32,32 L26.54,22.1 Q25.33,19.91 22.93,19.22 L12.06,16.1", 4.7],
  ["M32,32 L41.21,38.56 Q43.25,40.01 45.71,39.59 L56.86,37.67", 4.0],
  ["M32,32 L20.85,30.09 Q18.39,29.67 16.35,31.12 L7.14,37.67", 4.0],
  ["M32,32 L32.62,43.29 Q32.76,45.79 34.63,47.45 L43.06,54.97", 3.55],
  ["M32,32 L23.57,39.53 Q21.7,41.19 21.56,43.69 L20.94,54.97", 3.55],
];

export function AppMark({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      height={size}
      // The mark's ink sits 2.17 units above the field's centre because the
      // nodes are graded; shifting the view box up by that much centres it.
      viewBox="0 -2.17 64 64"
      width={size}
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        {SPOKES.map(([d, w]) => (
          <path d={d} key={d} strokeWidth={w} />
        ))}
      </g>
      <g fill="currentColor">
        {NODES.map(([cx, cy, r]) => (
          <circle cx={cx} cy={cy} key={`${cx}-${cy}`} r={r} />
        ))}
      </g>
    </svg>
  );
}
