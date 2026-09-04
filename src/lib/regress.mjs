/**
 * Catch-up projection.
 *
 * Each class's record-setting releases are fitted over a recent window with
 * both a linear and a quadratic least-squares model, and the fits answer:
 *
 *   1. When does an open-weight class reach the frontier's *current* score?
 *   2. Is the open trend gaining on the frontier trend, and if so when do the
 *      two meet?
 *
 * Both models are computed for every series so the page can switch between
 * them without recomputing anything in the browser. A quadratic always fits at
 * least as well as a linear one, so the two are compared with an F-test on the
 * curvature term rather than on raw R².
 */

const MONTH = 1000 * 60 * 60 * 24 * 30.4375;
const EPOCH = Date.UTC(2020, 0, 1);

export const toMonths = (iso) => (new Date(`${iso}T00:00:00Z`).getTime() - EPOCH) / MONTH;
export const fromMonths = (m) => new Date(EPOCH + m * MONTH).toISOString().slice(0, 10);

/* ── fitting ──────────────────────────────────────────────────────────────── */

/** Gauss-Jordan solve of a small dense system. */
function solve(A, b) {
  const n = A.length;
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]];
    [b[i], b[piv]] = [b[piv], b[i]];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

/**
 * Least-squares polynomial of the given degree.
 *
 * x is centred on its mean before fitting: months-since-2020 raised to the
 * fourth power otherwise makes the normal equations badly conditioned.
 */
export function polyFit(points, degree) {
  const n = points.length;
  if (n < degree + 2) return null;

  const x0 = points.reduce((a, p) => a + p.x, 0) / n;
  const X = points.map((p) => p.x - x0);
  const Y = points.map((p) => p.y);

  const sX = (k) => X.reduce((a, x) => a + x ** k, 0);
  const sXY = (k) => X.reduce((a, x, i) => a + x ** k * Y[i], 0);

  const m = degree + 1;
  const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => sX(i + j)));
  const coefs = solve(A, Array.from({ length: m }, (_, i) => sXY(i)));
  if (!coefs) return null;

  const at = (x) => coefs.reduce((a, c, i) => a + c * (x - x0) ** i, 0);
  const slopeAt = (x) => coefs.reduce((a, c, i) => (i ? a + i * c * (x - x0) ** (i - 1) : a), 0);

  const my = Y.reduce((a, c) => a + c, 0) / n;
  let ssr = 0, sst = 0;
  for (const p of points) {
    ssr += (p.y - at(p.x)) ** 2;
    sst += (p.y - my) ** 2;
  }

  // Uncentred coefficients, so two fits with different centres can be subtracted.
  const [c0 = 0, c1 = 0, c2 = 0] = coefs;
  const flat = [c0 - c1 * x0 + c2 * x0 ** 2, c1 - 2 * c2 * x0, c2];

  const df = n - m;
  return {
    degree, coefs, flat, x0, n, ssr, at, slopeAt,
    r2: sst === 0 ? 1 : 1 - ssr / sst,
    adjR2: sst === 0 || df <= 0 ? null : 1 - (ssr / df) / (sst / (n - 1)),
    // Standard error of the linear slope, for the gap test below.
    seSlope: degree === 1 && df > 0 ? Math.sqrt(ssr / df / X.reduce((a, x) => a + x * x, 0)) : Infinity,
    from: Math.min(...points.map((p) => p.x)),
    to: Math.max(...points.map((p) => p.x)),
  };
}

// Critical values of F(1, df) at alpha = 0.05.
const F_CRIT = { 1: 161.4, 2: 18.51, 3: 10.13, 4: 7.71, 5: 6.61, 6: 5.99, 7: 5.59, 8: 5.32, 9: 5.12, 10: 4.96, 12: 4.75, 15: 4.54, 20: 4.35, 25: 4.24, 30: 4.17, 40: 4.08, 60: 4.0, 120: 3.92 };
const fCritical = (df) => {
  if (df <= 0) return Infinity;
  if (df > 120) return 3.84;
  const keys = Object.keys(F_CRIT).map(Number);
  return F_CRIT[keys.reduce((a, b) => (Math.abs(b - df) < Math.abs(a - df) ? b : a))];
};

/** Is the quadratic's extra term justified, or is it just fitting noise? */
export function curvatureTest(linear, quadratic) {
  if (!linear || !quadratic) return null;
  const df = quadratic.n - 3;
  if (df <= 0 || quadratic.ssr <= 0) return { df, f: null, significant: false };
  const f = ((linear.ssr - quadratic.ssr) / 1) / (quadratic.ssr / df);
  const critical = fCritical(df);
  return { df, f, critical, significant: f > critical, direction: quadratic.flat[2] > 0 ? 'accelerating' : 'decelerating' };
}

/** Fit a series' records with both models, restricted to the lookback window. */
export function fitSeries(points, now, lookbackMonths, minPoints = 5) {
  const all = points.map((p) => ({ x: toMonths(p.date), y: p.value, point: p }));
  const recent = all.filter((p) => p.x >= now - lookbackMonths);
  const used = recent.length >= minPoints ? recent : all.slice(-minPoints);
  const linear = polyFit(used, 1);
  const quadratic = polyFit(used, 2);
  if (!linear) return null;
  return { points: used, linear, quadratic, curvature: curvatureTest(linear, quadratic) };
}

/* ── solving ──────────────────────────────────────────────────────────────── */

/** Real roots of a0 + a1·x + a2·x², ascending. */
function roots([a0, a1, a2]) {
  if (Math.abs(a2) < 1e-12) return Math.abs(a1) < 1e-12 ? [] : [-a0 / a1];
  const disc = a1 * a1 - 4 * a2 * a0;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-a1 - s) / (2 * a2), (-a1 + s) / (2 * a2)].sort((p, q) => p - q);
}

const earliestAfter = (xs, now) => xs.filter((x) => x > now).sort((a, b) => a - b)[0] ?? null;

/** When the fitted curve reaches `target`, at or after `now`. */
export function reaches(f, target, now) {
  if (!f) return null;
  const [a0, a1, a2] = f.flat;
  if (f.at(now) >= target) return now;
  return earliestAfter(roots([a0 - target, a1, a2]), now);
}

/**
 * Compare an open-weight trend against the baseline trend.
 *
 * For the linear model the honest question is whether the two slopes differ at
 * all, so the difference is tested against its own standard error. For the
 * quadratic model the curves can meet even when today's slopes are close, so
 * the crossing is solved directly and the caller is expected to surface the
 * curvature test alongside it.
 */
export function compare(openFit, baseFit, now, maxHorizonYears = 10, model = 'linear') {
  if (!openFit || !baseFit) return null;

  const gapNow = baseFit.at(now) - openFit.at(now);
  const rateGap = (openFit.slopeAt(now) - baseFit.slopeAt(now)) * 12;
  const result = { gapNow, gapRatePerYear: -rateGap, closing: rateGap > 0, crossover: null, verdict: '', distinguishable: true };

  if (model === 'linear') {
    const dSlope = openFit.flat[1] - baseFit.flat[1];
    const seDiff = Math.hypot(openFit.seSlope, baseFit.seSlope);
    result.distinguishable = Number.isFinite(seDiff) && Math.abs(dSlope) > 2 * seDiff;
    if (!result.distinguishable) { result.verdict = 'parallel'; return result; }
    if (dSlope <= 0) { result.verdict = 'widening'; return result; }
  }

  const diff = [0, 1, 2].map((i) => (openFit.flat[i] ?? 0) - (baseFit.flat[i] ?? 0));
  const x = earliestAfter(roots(diff), now);

  if (x == null) {
    result.verdict = result.closing ? 'beyond' : 'widening';
    return result;
  }
  if (x - now > maxHorizonYears * 12) { result.verdict = 'beyond'; return result; }
  result.crossover = x;
  result.verdict = 'crossing';
  return result;
}

/* ── assembly ─────────────────────────────────────────────────────────────── */

const MODELS = ['linear', 'quadratic'];

function outcome(fit, baseFit, target, now, maxHorizonYears, model) {
  if (!fit) return null;
  const matchX = reaches(fit, target, now);
  return {
    matchX,
    matchDate: matchX == null ? null : fromMonths(matchX),
    matchMonths: matchX == null ? null : matchX - now,
    ratePerYear: fit.slopeAt(now) * 12,
    vs: compare(fit, baseFit, now, maxHorizonYears, model),
  };
}

/** Everything the page needs for one metric, under both models. */
export function project(seriesById, categories, options, now) {
  const { baseline, lookbackMonths, maxHorizonYears } = options;
  const baseSeries = seriesById.get(baseline);
  if (!baseSeries?.points.length) return null;

  const baseFits = fitSeries(baseSeries.points, now, lookbackMonths);
  if (!baseFits) return null;

  const target = Math.max(...baseSeries.points.map((p) => p.value));

  const rows = categories
    .filter((c) => c.id !== baseline)
    .map((category) => {
      const series = seriesById.get(category.id);
      if (!series?.points.length) return null;
      const fits = fitSeries(series.points, now, lookbackMonths);
      if (!fits) return null;
      const models = Object.fromEntries(
        MODELS.map((m) => [m, outcome(fits[m], baseFits[m], target, now, maxHorizonYears, m)]),
      );
      return { category, fits, curvature: fits.curvature, current: series.points.at(-1), models };
    })
    .filter(Boolean);

  return {
    baseline,
    baseCategory: categories.find((c) => c.id === baseline),
    baseFits,
    target,
    rows,
    now,
    models: MODELS,
  };
}
