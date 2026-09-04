/**
 * One series, drawn small enough to live in a table row.
 *
 * Not recharts. The chart on the GPU page carries axes, a legend, a crosshair
 * and a tooltip because somebody is reading values off it; this is a shape in a
 * cell, and the answer it gives is "steady", "climbing" or "it fell off a
 * cliff". A hundred lines of SVG beats mounting a chart library per row.
 *
 * Scaled from zero rather than from the minimum. A memory trace that wanders
 * between 54 and 55 MiB is flat, and autoscaling would draw it as a mountain
 * range -- which is exactly the reading somebody would act on and be wrong.
 */

interface Props {
  /** Oldest first. Empty renders nothing rather than a misleading flat line. */
  values: number[];
  width?: number;
  height?: number;
  /** The top of the scale. Defaults to the largest value seen. */
  max?: number;
  colour?: string;
  title?: string;
}

export default function Sparkline({
  values, width = 120, height = 24, max, colour = '#4d9fd6', title,
}: Props) {
  if (values.length < 2) {
    return <span style={{ display: 'inline-block', width, height }} />;
  }

  // At most one point per two pixels. 240 samples drawn into 96 pixels is two
  // and a half points per pixel: the extra ones cannot be seen, they just
  // thicken the line into a smear and make a steady series look noisy.
  const budget = Math.max(2, Math.floor(width / 2));
  const points = values.length > budget
    ? Array.from({ length: budget },
                 (_, i) => values[Math.round(i * (values.length - 1) / (budget - 1))])
    : values;

  // A tenth of headroom above the highest point. Without it a steady series --
  // which is what a healthy container's memory is -- draws hard against the top
  // edge and reads as pegged at a maximum rather than as flat.
  const top = (Math.max(max ?? 0, ...points) || 1) * 1.1;
  const step = width / (points.length - 1);
  const y = (v: number) => height - 1 - (v / top) * (height - 2);
  const line = points.map((v, i) => `${i * step},${y(v)}`).join(' ');
  // Closed back along the baseline so the area reads as a quantity rather than
  // as a thread. Fill is the same hue at low alpha, which keeps the stroke the
  // thing the eye follows.
  const area = `0,${height} ${line} ${width},${height}`;

  return (
    <svg width={width} height={height} role="img" aria-label={title}
         style={{ display: 'block', overflow: 'visible' }}>
      {title && <title>{title}</title>}
      <polygon points={area} fill={colour} fillOpacity={0.14} />
      <polyline points={line} fill="none" stroke={colour} strokeWidth={1.5}
                strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={y(points[points.length - 1])} r={2} fill={colour} />
    </svg>
  );
}
