/** Data layer: categorise models, collapse effort variants, find record-setters. */

/**
 * Artificial Analysis lists one row per reasoning-effort variant
 * ("Claude Opus 5 (Adaptive Reasoning, Max Effort)"). For charting we want one
 * entry per release, labelled with the release name.
 */
export function baseName(name) {
  let out = name;
  // Strip trailing parentheticals repeatedly: "Foo (Non-reasoning) (May)" -> "Foo".
  for (let prev = null; prev !== out; ) {
    prev = out;
    out = out.replace(/\s*\([^()]*\)\s*$/, '').trim();
  }
  return out || name;
}

/** Does a model fall into this category? */
export function matches(model, { match = {} }) {
  if (match.openWeights != null && Boolean(model.isOpenWeights) !== match.openWeights) return false;
  if (match.minParams != null || match.maxParams != null) {
    const p = model.totalParameters;
    if (p == null) return false;
    if (match.minParams != null && p < match.minParams) return false;
    if (match.maxParams != null && p >= match.maxParams) return false;
  }
  return true;
}

/**
 * The record-setting models for one category and metric: walk releases in date
 * order and keep each one that beats every model released before it.
 */
export function records(models, category, metric) {
  const eligible = models.filter((m) => m[metric] != null && matches(m, category));

  // Collapse variants to the best-scoring row per release.
  const byRelease = new Map();
  for (const m of eligible) {
    const key = baseName(m.name);
    const held = byRelease.get(key);
    if (!held || m[metric] > held[metric]) byRelease.set(key, m);
  }

  const ordered = [...byRelease.values()].sort(
    (a, b) => a.releaseDate.localeCompare(b.releaseDate) || b[metric] - a[metric],
  );

  const out = [];
  let best = -Infinity;
  for (const m of ordered) {
    if (m[metric] <= best) continue;
    best = m[metric];
    out.push({
      ...m,
      label: baseName(m.name),
      value: m[metric],
      date: m.releaseDate,
      categoryId: category.id,
    });
  }
  return out;
}

/** Build every series for one chart. */
export function buildSeries(models, categories, metric) {
  return categories.map((category) => ({
    id: category.id,
    category,
    points: records(models, category, metric),
  }));
}

/**
 * How far behind the frontier a category sits: the date the frontier first
 * reached this category's current score, expressed in months.
 */
export function lagMonths(frontierPoints, value) {
  const reached = frontierPoints.find((p) => p.value >= value);
  const latest = frontierPoints.at(-1);
  if (!reached || !latest) return null;
  const months = (new Date(latest.date) - new Date(reached.date)) / (1000 * 60 * 60 * 24 * 30.44);
  return Math.max(0, months);
}

/** Headline numbers for the stat strip. */
export function summarise(models, seriesById, metric) {
  const frontier = seriesById.get('frontier')?.points ?? [];
  const topFrontier = frontier.at(-1) ?? null;
  const openSeries = [...seriesById.values()].filter((s) => s.id !== 'frontier');
  const openBest = openSeries
    .flatMap((s) => s.points)
    .reduce((a, b) => (!a || b.value > a.value ? b : a), null);

  return {
    metric,
    modelCount: models.filter((m) => m[metric] != null).length,
    openCount: models.filter((m) => m[metric] != null && m.isOpenWeights).length,
    topFrontier,
    openBest,
    gap: topFrontier && openBest ? topFrontier.value - openBest.value : null,
    lag: topFrontier && openBest ? lagMonths(frontier, openBest.value) : null,
  };
}
