/**
 * Server-rendered SVG line charts.
 *
 * Charts are emitted as static markup at build time — no client-side charting
 * library, no layout work in the browser. Series colours are referenced through
 * CSS custom properties so the same markup works in light and dark themes.
 */
import { esc, textWidth, fmt, shortDate, monthYear } from './util.mjs';
import { toMonths, fromMonths } from './regress.mjs';

const M = { top: 28, right: 26, bottom: 46, left: 56 };
const DAY = 86400000;

const toDate = (s) => new Date(`${s}T00:00:00Z`).getTime();

/* ── scales ───────────────────────────────────────────────────────────────── */

function niceCeil(v) {
  if (v <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / (mag / 2)) * (mag / 2);
}

function yTicks(min, max, target = 6) {
  const span = max - min;
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/** One tick per year, plus unlabelled quarter marks. */
function xTicks(minMs, maxMs) {
  const out = [];
  const start = new Date(minMs).getUTCFullYear();
  const end = new Date(maxMs).getUTCFullYear();
  for (let y = start; y <= end + 1; y++) {
    for (let q = 0; q < 12; q += 3) {
      const ms = Date.UTC(y, q, 1);
      if (ms < minMs || ms > maxMs) continue;
      out.push({ ms, label: q === 0 ? String(y) : null });
    }
  }
  return out;
}

/* ── label placement ──────────────────────────────────────────────────────── */

/**
 * Candidate slots for an annotation, in preference order: close and beside the
 * point first, then progressively further above or below. Slots far from the
 * point get a leader line so the reader can still trace the pairing.
 */
const CANDIDATES = (() => {
  const out = [];
  for (let ring = 0; ring < 8; ring++) {
    const up = 3 + ring * 9;
    const down = 11 + ring * 9;
    out.push([11, -up, 'start'], [11, down, 'start'], [-11, -up, 'end'], [-11, down, 'end']);
    if (ring) out.push([0, -up - 7, 'middle'], [0, down + 7, 'middle']);
  }
  return out;
})();

/** Area of intersection between two label rects, 0 when they are clear. */
function overlapArea(a, b, pad = 2.5) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + pad * 2;
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + pad * 2;
  return w > 0 && h > 0 ? w * h : 0;
}

const overlaps = (a, b, pad = 2) =>
  a.x0 - pad < b.x1 && a.x1 + pad > b.x0 && a.y0 - pad < b.y1 && a.y1 + pad > b.y0;

/** Does segment p→q pass through rect r? Cheap conservative test. */
function segmentHitsRect(p, q, r) {
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
  }
  return false;
}

function rectFor(label, [dx, dy, anchor]) {
  const x = label.px + dx;
  const y = label.py + dy;
  const w = label.w;
  const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
  return { x0, y0: y - label.fs, x1: x0 + w, y1: y + 3, tx: x, ty: y, anchor, dx, dy };
}

/** Cost of putting `label` in one candidate slot. Lower is better. */
function slotCost(label, index, others, ctx) {
  const { plot, markers, segments } = ctx;
  const r = rectFor(label, CANDIDATES[index]);
  let score = index * 0.9 + Math.hypot(r.dx, r.dy) * 0.35;

  if (r.x0 < plot.x0 - 4 || r.x1 > plot.x1 + 4) score += 4000;
  if (r.y0 < plot.y0 - 2 || r.y1 > plot.y1 + 2) score += 4000;

  // A clean slot is worth far more than a close one.
  for (const p of others) {
    const a = overlapArea(r, p.rect);
    if (a > 0) score += 150 + a * 1.1;
  }
  for (const m of markers) {
    if (m.x >= r.x0 - 3 && m.x <= r.x1 + 3 && m.y >= r.y0 - 3 && m.y <= r.y1 + 3) {
      score += m.id === label.id ? 0 : 90;
    }
  }
  for (const [p, q] of segments) {
    if (Math.min(p.x, q.x) > r.x1 || Math.max(p.x, q.x) < r.x0) continue;
    if (segmentHitsRect(p, q, r)) score += 11;
  }
  return { score, rect: r, index };
}

const bestSlot = (label, others, ctx) =>
  CANDIDATES.reduce((best, _, i) => {
    const slot = slotCost(label, i, others, ctx);
    return !best || slot.score < best.score ? slot : best;
  }, null);

/**
 * Two passes. First a left-to-right greedy sweep, then a repair loop that
 * re-seats any label still colliding — by then it can see every other label,
 * not just the ones placed before it, which clears most of what the sweep
 * paints itself into.
 */
function placeLabels(labels, plot, markers, segments) {
  const ctx = { plot, markers, segments };
  const placed = [];

  for (const label of [...labels].sort((a, b) => a.px - b.px || a.py - b.py)) {
    const slot = bestSlot(label, placed, ctx);
    placed.push({ ...label, rect: slot.rect, index: slot.index });
  }

  for (let round = 0; round < 8; round++) {
    let improved = false;
    for (let k = 0; k < placed.length; k++) {
      const others = placed.filter((_, j) => j !== k);
      const current = slotCost(placed[k], placed[k].index, others, ctx);
      if (current.score < 100) continue; // already collision-free
      const better = bestSlot(placed[k], others, ctx);
      if (better.score < current.score - 0.5) {
        placed[k] = { ...placed[k], rect: better.rect, index: better.index };
        improved = true;
      }
    }
    if (!improved) break;
  }

  return placed.map((l) => {
    const cx = (l.rect.x0 + l.rect.x1) / 2;
    const cy = (l.rect.y0 + l.rect.y1) / 2;
    return { ...l, leader: Math.hypot(cx - l.px, cy - l.py) > 26 };
  });
}

/* ── rendering ────────────────────────────────────────────────────────────── */

function pathFor(pts, style) {
  if (!pts.length) return '';
  if (style === 'step') {
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) d += `H${pts[i].x}V${pts[i].y}`;
    return d;
  }
  return 'M' + pts.map((p) => `${p.x},${p.y}`).join('L');
}

export function renderChart(chart, series, options) {
  const { width: W, height: H, showScores, minDate } = options;
  const minMs = minDate ? toDate(minDate) : null;

  // Clip to the window, carrying the standing record in at the left edge.
  const prepared = series.map((s) => {
    let points = s.points;
    if (minMs) {
      const before = points.filter((p) => toDate(p.date) < minMs);
      const after = points.filter((p) => toDate(p.date) >= minMs);
      const carried = before.at(-1);
      points = carried ? [{ ...carried, ms: minMs, carried: true }, ...after] : after;
    }
    return { ...s, points: points.map((p) => ({ ...p, ms: p.ms ?? toDate(p.date) })) };
  }).filter((s) => s.points.length);

  const all = prepared.flatMap((s) => s.points);
  if (!all.length) return `<p class="empty">No data for ${esc(chart.metric)}.</p>`;

  const x0 = Math.min(...all.map((p) => p.ms));
  const x1 = Math.max(...all.map((p) => p.ms));
  const padX = Math.max((x1 - x0) * 0.035, 14 * DAY);
  const dMin = x0 - padX;
  const dMax = x1 + padX;

  const vMax = niceCeil(Math.max(...all.map((p) => p.value)) * 1.06);
  const vMin = chart.yMin ?? 0;

  const plot = { x0: M.left, y0: M.top, x1: W - M.right, y1: H - M.bottom };
  const sx = (ms) => plot.x0 + ((ms - dMin) / (dMax - dMin)) * (plot.x1 - plot.x0);
  const sy = (v) => plot.y1 - ((v - vMin) / (vMax - vMin)) * (plot.y1 - plot.y0);

  // Project points and gather geometry for the label solver.
  const projected = prepared.map((s) => ({
    ...s,
    pts: s.points.map((p) => ({ ...p, x: sx(p.ms), y: sy(p.value) })),
  }));

  const markers = [];
  const segments = [];
  const labels = [];

  // The consumer tiers are cumulative, so one release can hold the record in
  // more than one class. Annotate such a point once — on the narrowest class
  // that claims it, which is the series drawn on top — and let the shared line
  // segment carry the rest.
  const labelled = new Set();

  for (const s of projected) {
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i];
      if (!p.carried) markers.push({ id: `${s.id}-${i}`, x: p.x, y: p.y });
      if (i) segments.push([s.pts[i - 1], s.pts[i]]);
    }
  }

  for (const s of [...projected].reverse()) {
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i];
      if (p.carried) continue;
      const key = `${p.label}|${p.value.toFixed(3)}`;
      if (labelled.has(key)) continue;
      labelled.add(key);
      const fs = 10.5;
      const text = showScores ? `${p.label} ${fmt(p.value, 1)}` : p.label;
      labels.push({ id: `${s.id}-${i}`, seriesId: s.id, text, px: p.x, py: p.y, fs, w: textWidth(text, fs), point: p });
    }
  }

  const positioned = placeLabels(labels, plot, markers, segments);
  const byId = new Map(positioned.map((l) => [l.id, l]));

  /* markup */
  const gridY = yTicks(vMin, vMax)
    .map((v) => {
      const y = sy(v);
      return `<line class="grid" x1="${plot.x0}" x2="${plot.x1}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>` +
        `<text class="axis y" x="${plot.x0 - 10}" y="${(y + 3.5).toFixed(1)}">${fmt(v, 0)}</text>`;
    }).join('');

  const gridX = xTicks(dMin, dMax)
    .map(({ ms, label }) => {
      const x = sx(ms).toFixed(1);
      const line = `<line class="grid${label ? ' major' : ''}" x1="${x}" x2="${x}" y1="${plot.y0}" y2="${plot.y1}"/>`;
      return label
        ? `${line}<text class="axis x" x="${x}" y="${plot.y1 + 20}">${label}</text>`
        : line;
    }).join('');

  const body = projected.map((s) => {
    const c = s.category;
    const cls = `s-${s.id}`;
    const line = `<path class="line ${cls}${c.emphasis ? ' lead' : ''}" d="${pathFor(s.pts, chart.lineStyle)}"/>`;

    const dots = s.pts.filter((p) => !p.carried).map((p, i) => {
      const idx = s.pts.findIndex((q) => q === p);
      const l = byId.get(`${s.id}-${idx}`);
      const d = [
        `data-name="${esc(p.label)}"`,
        `data-creator="${esc(p.modelCreatorName ?? '')}"`,
        `data-date="${esc(shortDate(p.date))}"`,
        `data-score="${fmt(p.value, 1)}"`,
        `data-metric="${esc(chart.yLabel)}"`,
        `data-category="${esc(c.label)}"`,
        `data-params="${p.totalParameters != null ? `${fmt(p.totalParameters, 0)}B total${p.activeParameters ? ` · ${fmt(p.activeParameters, 0)}B active` : ''}` : ''}"`,
        `data-license="${esc(p.licenseName ?? (p.isOpenWeights ? 'Open weights' : 'Proprietary'))}"`,
      ].join(' ');
      return `<circle class="dot ${cls}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" tabindex="0" ${d}><title>${esc(p.label)} — ${fmt(p.value, 1)}</title></circle>` +
        (l?.leader
          ? `<line class="leader ${cls}" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${((l.rect.x0 + l.rect.x1) / 2).toFixed(1)}" y2="${((l.rect.y0 + l.rect.y1) / 2 + 4).toFixed(1)}"/>`
          : '');
    }).join('');

    const anns = s.pts.map((p, i) => {
      const l = byId.get(`${s.id}-${i}`);
      if (!l) return '';
      return `<text class="ann ${cls}" x="${l.rect.tx.toFixed(1)}" y="${l.rect.ty.toFixed(1)}" text-anchor="${l.rect.anchor}">${esc(l.text)}</text>`;
    }).join('');

    return `<g class="series ${cls}" data-series="${s.id}">${line}${dots}${anns}</g>`;
  }).join('');

  const desc = projected
    .map((s) => `${s.category.label}: best is ${s.pts.at(-1).label} at ${fmt(s.pts.at(-1).value, 1)}`)
    .join('. ');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet" aria-labelledby="${chart.id}-t ${chart.id}-d">
<title id="${chart.id}-t">${esc(chart.title)}</title><desc id="${chart.id}-d">${esc(desc)}.</desc>
<g class="grid-g">${gridY}${gridX}</g>
<line class="axis-line" x1="${plot.x0}" x2="${plot.x1}" y1="${plot.y1}" y2="${plot.y1}"/>
<text class="axis-title" transform="translate(14 ${(plot.y0 + plot.y1) / 2}) rotate(-90)" text-anchor="middle">${esc(chart.yLabel)}</text>
${body}
</svg>`;
}

/* ── projection chart ─────────────────────────────────────────────────────── */

/**
 * Fitted trends extended past today, against the frontier's standing score.
 * Deliberately plainer than the history charts: no per-point annotations, so
 * the eye follows the slopes and where they meet the target line.
 */
export function renderProjection(chart, projection, options) {
  const { width: W, horizonMonths } = options;
  const H = options.projectionHeight ?? 430;
  const { baseFits, baseCategory, target, rows, now, models } = projection;

  const P = { top: 26, right: 118, bottom: 46, left: 56 };
  const plot = { x0: P.left, y0: P.top, x1: W - P.right, y1: H - P.bottom };
  const clip = `clip-${chart.id}`;

  const series = [
    { category: baseCategory, fits: baseFits, models: null },
    ...rows,
  ];

  const xMin = Math.min(...series.map((s) => s.fits.linear.from));
  const xMax = now + horizonMonths;

  // The y-axis tracks the observed range, identical under both models, so the
  // axes stay put when the reader switches and only the curves move. Fitted
  // curves are clipped and run off the top rather than rescaling everything.
  const observed = Math.max(target, ...series.flatMap((s) => s.fits.points.map((p) => p.y)));
  const vMax = niceCeil(observed * 1.22);

  const sx = (m) => plot.x0 + ((m - xMin) / (xMax - xMin)) * (plot.x1 - plot.x0);
  const sy = (v) => plot.y1 - (v / vMax) * (plot.y1 - plot.y0);

  const gridY = yTicks(0, vMax)
    .map((v) => {
      const y = sy(v).toFixed(1);
      return `<line class="grid" x1="${plot.x0}" x2="${plot.x1}" y1="${y}" y2="${y}"/>` +
        `<text class="axis y" x="${plot.x0 - 10}" y="${(+y + 3.5).toFixed(1)}">${fmt(v, 0)}</text>`;
    }).join('');

  const gridX = xTicks(
    new Date(`${fromMonths(xMin)}T00:00:00Z`).getTime(),
    new Date(`${fromMonths(xMax)}T00:00:00Z`).getTime(),
  ).map(({ ms, label }) => {
    const m = toMonths(new Date(ms).toISOString().slice(0, 10));
    if (m < xMin || m > xMax) return '';
    const x = sx(m).toFixed(1);
    const line = `<line class="grid${label ? ' major' : ''}" x1="${x}" x2="${x}" y1="${plot.y0}" y2="${plot.y1}"/>`;
    return label ? `${line}<text class="axis x" x="${x}" y="${plot.y1 + 20}">${label}</text>` : line;
  }).join('');

  const nowX = sx(now);
  const targetY = sy(target);

  const today = `<line class="now-line" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${plot.y0}" y2="${plot.y1}"/>` +
    `<text class="now-label" x="${(nowX - 6).toFixed(1)}" y="${plot.y0 + 12}" text-anchor="end">today</text>`;

  const targetLine = `<line class="target-line s-${baseCategory.id}" x1="${plot.x0}" x2="${plot.x1}" y1="${targetY.toFixed(1)}" y2="${targetY.toFixed(1)}"/>` +
    `<text class="target-label s-${baseCategory.id}" x="${plot.x1 + 8}" y="${(targetY + 3.5).toFixed(1)}">frontier<tspan x="${plot.x1 + 8}" dy="12">today ${fmt(target, 1)}</tspan></text>`;

  /** Sample a fit into a path; quadratics need the polyline, linears are free. */
  const curve = (f, a, b, steps = 48) => {
    if (b <= a) return '';
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const x = a + ((b - a) * i) / steps;
      pts.push(`${sx(x).toFixed(1)},${sy(f.at(x)).toFixed(1)}`);
    }
    return `M${pts.join('L')}`;
  };

  // Observed records are the same under either model, so they sit outside the layers.
  const dots = series.map((s) => s.fits.points
    .map((p) => `<circle class="pdot s-${s.category.id}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.6"><title>${esc(p.point.label)} — ${fmt(p.y, 1)}</title></circle>`)
    .join('')).join('');

  const layers = models.map((model) => {
    // Crossing labels cluster tightly; stagger them above and below the line.
    const order = rows
      .filter((r) => r.models[model]?.matchMonths > 0 && r.models[model].matchX <= xMax)
      .sort((a, b) => a.models[model].matchX - b.models[model].matchX);
    // Four alternating levels: under the quadratic model the crossings can land
    // within weeks of each other, so two levels are not enough separation.
    const LEVELS = [-12, 21, -28, 37];
    const offset = new Map(order.map((r, i) => [r.category.id, LEVELS[i % LEVELS.length]]));

    const body = series.map((s) => {
      const f = s.fits[model];
      if (!f) return '';
      const cls = `s-${s.category.id}`;
      const split = Math.min(f.to, now);
      const out = s.models?.[model];

      let hit = '';
      if (offset.has(s.category.id)) {
        const hx = sx(out.matchX);
        hit = `<circle class="phit ${cls}" cx="${hx.toFixed(1)}" cy="${targetY.toFixed(1)}" r="4.5"/>` +
          `<text class="phit-label ${cls}" x="${hx.toFixed(1)}" y="${(targetY + offset.get(s.category.id)).toFixed(1)}" text-anchor="middle">${esc(monthYear(out.matchDate))}</text>`;
      }

      return `<g class="series ${cls}" data-series="${s.category.id}">` +
        `<g clip-path="url(#${clip})">` +
        `<path class="line fitline" d="${curve(f, f.from, split)}"/>` +
        `<path class="line fitline dashed" d="${curve(f, split, xMax)}"/></g>${hit}</g>`;
    }).join('');

    return `<g class="model-layer" data-for="${model}">${body}</g>`;
  }).join('');

  const desc = rows
    .map((r) => `${r.category.label} reaches ${fmt(target, 1)} around ${r.models.linear?.matchDate ? monthYear(r.models.linear.matchDate) : 'no date on this trend'}`)
    .join('. ');

  return `<svg class="chart projection" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet" aria-labelledby="${chart.id}-pt ${chart.id}-pd">
<title id="${chart.id}-pt">${esc(chart.yLabel)} catch-up projection</title><desc id="${chart.id}-pd">${esc(desc)} (linear model).</desc>
<defs><clipPath id="${clip}"><rect x="${plot.x0}" y="${plot.y0 - 4}" width="${plot.x1 - plot.x0}" height="${plot.y1 - plot.y0 + 4}"/></clipPath></defs>
<g class="grid-g">${gridY}${gridX}</g>
<line class="axis-line" x1="${plot.x0}" x2="${plot.x1}" y1="${plot.y1}" y2="${plot.y1}"/>
<text class="axis-title" transform="translate(14 ${(plot.y0 + plot.y1) / 2}) rotate(-90)" text-anchor="middle">${esc(chart.yLabel)}</text>
${today}${targetLine}<g class="obs">${dots}</g>${layers}
</svg>`;
}
