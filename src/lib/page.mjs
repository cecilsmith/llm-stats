/** Assembles the static HTML document. */
import { esc, fmt, monthYear, humanMonths, shortDate } from './util.mjs';
import { renderChart, renderProjection, renderProviderChart } from './chart.mjs';
import { fromMonths } from './regress.mjs';

const MARK = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fill="currentColor" d="M13.982 16h1.996v-3.997h-3.992V16zM7.984 0 3.992 3.997H0v3.998h5.988L9.98 3.997h2.006V0zM7.984 7.995l-3.992 4.008H0V16h5.988l3.992-3.997h2.006V7.995zM15.978 7.995V3.997h-3.992v3.998h3.992"/></svg>';

const SUN = '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

function legend(categories) {
  return `<div class="legend" role="group" aria-label="Toggle model classes">${categories
    .map((c) => `<button type="button" class="chip c-${esc(c.id)}" data-series="${esc(c.id)}" aria-pressed="true"><i class="swatch"></i>${esc(c.legend ?? c.label)}</button>`)
    .join('')}</div>`;
}

function figure(chart, series, options, categories) {
  const present = series.filter((s) => s.points.length);
  const latest = present
    .map((s) => s.points.at(-1))
    .sort((a, b) => b.value - a.value)[0];

  return `<figure class="figure" id="${esc(chart.id)}">
  <div class="figure-bar">${legend(present.map((s) => s.category))}<span class="hint">Click a class to hide it · hover a point for detail</span></div>
  <div class="chart-scroll">${renderChart(chart, series, options)}</div>
  <figcaption class="figure-foot">Each point is the first model to set a new record for its class on ${esc(chart.yLabel)}. Highest to date: <strong>${esc(latest.label)}</strong> at ${fmt(latest.value, 1)}.</figcaption>
</figure>`;
}

function statTiles(s, chart) {
  const tiles = [
    {
      k: `Frontier ${chart.yLabel.replace(' Index', '')}`,
      v: fmt(s.topFrontier?.value, 1),
      n: s.topFrontier ? `<em>${esc(s.topFrontier.label)}</em> · ${esc(monthYear(s.topFrontier.date))}` : '',
    },
    {
      k: 'Best open weights',
      v: fmt(s.openBest?.value, 1),
      n: s.openBest ? `<em>${esc(s.openBest.label)}</em> · ${esc(monthYear(s.openBest.date))}` : '',
    },
    {
      k: 'Gap to frontier',
      v: s.gap == null ? '—' : fmt(s.gap, 1),
      n: 'index points between the best open and closed model',
    },
    {
      k: 'Open-weight lag',
      v: humanMonths(s.lag),
      n: 'since the frontier passed today’s best open score',
    },
  ];
  return `<div class="stats-band"><div class="wrap"><div class="stats">${tiles
    .map((t) => `<div class="stat"><div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="n">${t.n}</div></div>`)
    .join('')}</div></div></div>`;
}

function classCards(categories, seriesById) {
  return `<div class="classes">${categories
    .map((c) => {
      const best = seriesById.get(c.id)?.points.at(-1);
      return `<article class="class-card c-${esc(c.id)}">
      <h3>${esc(c.label)}</h3>
      <p>${esc(c.blurb)}</p>
      ${best ? `<div class="lead-model"><b>${fmt(best.value, 1)}</b><span>${esc(best.label)} · ${esc(monthYear(best.date))}</span></div>` : ''}
    </article>`;
    })
    .join('')}</div>`;
}

function leaderTable(categories, charts, seriesByChart) {
  const head = `<tr><th>Class</th><th>Leading model</th><th>Released</th>${charts
    .map((c) => `<th style="text-align:right">${esc(c.yLabel)}</th>`)
    .join('')}<th style="text-align:right">Params</th></tr>`;

  const rows = categories.map((c) => {
    const primary = seriesByChart.get(charts[0].id).get(c.id)?.points.at(-1);
    if (!primary) return '';
    const cells = charts.map((ch) => {
      const p = seriesByChart.get(ch.id).get(c.id)?.points.at(-1);
      return `<td class="num">${p ? fmt(p.value, 1) : '—'}</td>`;
    }).join('');
    return `<tr class="c-${esc(c.id)}">
      <td><span class="tag"><i></i>${esc(c.label)}</span></td>
      <td class="model-cell"><b>${esc(primary.label)}</b><small>${esc(primary.modelCreatorName ?? '')}</small></td>
      <td>${esc(shortDate(primary.date))}</td>
      ${cells}
      <td class="num">${primary.totalParameters != null ? `${fmt(primary.totalParameters, 0)}B` : '—'}</td>
    </tr>`;
  }).join('');

  return `<div class="table-scroll"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}


/* ── projection ──────────────────────────────────────────────────────── */

const MODEL_LABEL = { linear: 'Linear', quadratic: 'Quadratic' };

const VERDICT = {
  crossing: (o) => `<b>Closing</b> \u2014 trends meet ${esc(monthYear(fromMonths(o.vs.crossover)))}`,
  beyond: () => '<b>Closing</b>, but not within a ten-year horizon',
  widening: (o) => `<b>Widening</b> by ${fmt(Math.abs(o.vs.gapRatePerYear), 1)} pts/year`,
  // Slope difference sits inside its own noise: neither direction is supportable.
  parallel: (o) => `<b>Roughly constant</b><small>point estimate ${
    o.vs.closing ? 'closing' : 'widening'
  } ${fmt(Math.abs(o.vs.gapRatePerYear), 1)} pts/yr, within noise</small>`,
};

/** A cell whose contents depend on the selected model. */
const perModel = (models, render) =>
  models.map((m) => `<span data-for="${m}">${render(m)}</span>`).join('');

function modelToggle(id, models, active) {
  return `<div class="seg" role="group" aria-label="Regression model">${models
    .map((m) => `<button type="button" class="seg-btn" data-model-btn="${m}" data-target="${id}" aria-pressed="${m === active}">${MODEL_LABEL[m]}</button>`)
    .join('')}</div>`;
}

function reachCell(o) {
  if (!o || o.matchDate == null || o.matchMonths == null) return '<span class="muted">no date on this trend</span>';
  if (o.matchMonths <= 0.5) return '<b>already there</b>';
  return `<b>${esc(monthYear(o.matchDate))}</b><small>${humanMonths(o.matchMonths)} away</small>`;
}

function projectionTable(proj, rowAttrs = () => '') {
  const { models } = proj;

  const fitCells = (fits, curv) => {
    const better = curv?.significant;
    return `<td class="num r2" data-col="linear">${fmt(fits.linear.r2, 3)}</td>` +
      `<td class="num r2" data-col="quadratic">${fits.quadratic ? fmt(fits.quadratic.r2, 3) : '\u2014'}` +
      (curv?.f != null
        ? `<small>${better ? 'curvature significant' : 'not significant'} (F=${fmt(curv.f, 1)})</small>`
        : '<small>too few records</small>') + '</td>';
  };

  const rows = proj.rows.map((r) => `<tr class="c-${esc(r.category.id)}${r.on === false ? ' is-off' : ''}" ${rowAttrs(r)}>
      <td><span class="tag"><i></i>${esc(r.category.label)}</span></td>
      <td class="num">${fmt(r.current.value, 1)}</td>
      <td class="num">${perModel(models, (m) => (r.models[m] ? fmt(r.models[m].ratePerYear, 1) : '\u2014'))}</td>
      ${fitCells(r.fits, r.curvature)}
      <td class="model-cell">${perModel(models, (m) => (r.models[m] ? reachCell(r.models[m]) : '<span class="muted">\u2014</span>'))}</td>
      <td class="verdict">${perModel(models, (m) => (r.models[m] ? VERDICT[r.models[m].vs.verdict](r.models[m]) : '<span class="muted">too few records to fit</span>'))}</td>
    </tr>`).join('');

  const b = proj.baseFits;
  return `<div class="table-scroll"><table>
  <thead><tr>
    <th>Class</th><th style="text-align:right">Today</th>
    <th style="text-align:right">Pts / year<small>at today</small></th>
    <th style="text-align:right" data-col="linear">R\u00b2 linear</th>
    <th style="text-align:right" data-col="quadratic">R\u00b2 quadratic</th>
    <th>Reaches ${fmt(proj.target, 1)}</th><th>Gap to frontier</th>
  </tr></thead>
  <tbody>${rows}
    <tr class="c-${esc(proj.baseline)} baseline-row">
      <td><span class="tag"><i></i>${esc(proj.baseCategory.label)}</span></td>
      <td class="num">${fmt(proj.target, 1)}</td>
      <td class="num">${perModel(models, (m) => fmt(b[m].slopeAt(proj.now) * 12, 1))}</td>
      ${fitCells(b, b.curvature)}
      <td class="muted">baseline</td><td class="muted">\u2014</td>
    </tr>
  </tbody></table></div>`;
}

/** Lead paragraphs, written once per model and swapped with the toggle. */
function leadFor(proj, model, scope = '') {
  const soonest = proj.rows
    .filter((r) => r.models[model]?.matchMonths > 0.5)
    .sort((a, b) => a.models[model].matchMonths - b.models[model].matchMonths)[0];

  const reach = soonest
    ? `${scope}the soonest to reach today&rsquo;s frontier score of ${fmt(proj.target, 1)} is <strong>${esc(soonest.category.label)}</strong>, around <strong>${esc(monthYear(soonest.models[model].matchDate))}</strong> \u2014 ${humanMonths(soonest.models[model].matchMonths)} from now.`
    : `${scope}every one is already at or past the frontier&rsquo;s current score of ${fmt(proj.target, 1)} under this model.`;

  const fitted = proj.rows.filter((r) => r.models[model]);
  const crossing = fitted
    .filter((r) => r.models[model].vs.verdict === 'crossing')
    .sort((a, b) => a.models[model].vs.crossover - b.models[model].vs.crossover)[0];
  const allParallel = fitted.length > 0 && fitted.every((r) => r.models[model].vs.verdict === 'parallel');
  const allWidening = fitted.length > 0 && fitted.every((r) => r.models[model].vs.verdict === 'widening');

  const catchUp = crossing
    ? `Looking further out, <strong>${esc(crossing.category.label)}</strong> is gaining on the frontier fast enough that the two trends meet around <strong>${esc(monthYear(fromMonths(crossing.models[model].vs.crossover)))}</strong>.`
    : allParallel
      ? 'Whether any class is <em>gaining</em> on the frontier is a different question, and this model cannot answer it: every slope difference sits inside its own standard error, so the gap is best read as holding roughly constant.'
      : allWidening
        ? 'No class is closing under this model: every open trend rises more slowly than the frontier&rsquo;s, so the gap widens from here.'
        : 'The remaining classes are not measurably gaining on the frontier.';

  const note = model === 'quadratic'
    ? ` <span class="model-note">Quadratic fits extrapolate acceleration, so they land earlier than the linear ones \u2014 and diverge fast past the fitted window.</span>`
    : '';

  return `<p class="proj-lead" data-for="${model}">${reach}</p><p class="proj-lead" data-for="${model}">${catchUp}${note}</p>`;
}

function projectionBlock(chart, proj, options, active, id = `proj-${chart.id}`, rowAttrs, showLegend = true, scope = 'On its current trend, ') {
  const curv = proj.baseFits.curvature;
  return `<div class="proj-block" id="${id}" data-model="${active}">
  <div class="proj-head">
    <h3>${esc(chart.yLabel)}</h3>
    ${modelToggle(id, proj.models, active)}
  </div>
  ${proj.models.map((m) => leadFor(proj, m, scope)).join('')}
  <figure class="figure">
    ${showLegend ? `<div class="figure-bar">${legend([proj.baseCategory, ...proj.rows.map((r) => r.category)])}<span class="hint">Click a class to hide it</span></div>` : ''}
    <div class="chart-scroll">${renderProjection(chart, proj, options)}</div>
    <figcaption class="figure-foot">Solid where the fit is supported by releases, dashed where it is extrapolated. Dots are the record-setting releases both models were fitted to. On this metric the quadratic term is <strong>${curv?.significant ? 'a real improvement' : 'not statistically justified'}</strong> for the frontier series (F=${fmt(curv?.f, 1)} against a ${fmt(curv?.critical, 2)} threshold).</figcaption>
  </figure>
  ${projectionTable(proj, rowAttrs)}
</div>`;
}


/* ── provider explorer ───────────────────────────────────────────────────── */

function providerPicker(providers) {
  const items = providers.map((p) => `<label class="pick c-${esc(p.id)}">
    <input type="checkbox" data-provider="${esc(p.id)}"${p.on ? ' checked' : ''}>
    <i class="swatch"></i>
    <span class="pname">${esc(p.name)}</span>
    <span class="pmeta">${p.count} · ${fmt(p.best, 1)}</span>
  </label>`).join('');

  return `<div class="picker" id="provider-picker">
  <div class="picker-head">
    <span class="picker-count"><b data-shown>${providers.filter((p) => p.on).length}</b> of ${providers.length} providers shown</span>
    <span class="picker-actions">
      <button type="button" class="mini" data-pick="all">All</button>
      <button type="button" class="mini" data-pick="none">None</button>
      <button type="button" class="mini" data-pick="reset">Reset</button>
    </span>
  </div>
  <div class="picker-list">${items}</div>
</div>`;
}

function providerSection(chart, providers, proj, options, activeModel) {
  const shown = providers.filter((p) => p.on).map((p) => p.name);
  return `<section id="providers">
    <div class="wrap">
      <div class="sec-head">
        <h2>By provider</h2>
        <p>Every scored model plotted against ${esc(chart.yLabel)}, grouped by who built it. Faint dots are the whole catalogue; the solid line traces each provider&rsquo;s own record setters. Starts on the ${shown.length} providers with the most scored models — ${esc(shown.join(', '))} — and you can pick any combination.</p>
      </div>
      ${providerPicker(providers)}
      <figure class="figure" id="provider-figure">
        <div class="chart-scroll">${renderProviderChart(chart, providers, options)}</div>
        <figcaption class="figure-foot">Small dots are individual releases; larger dots are the ones that set a personal best. Reasoning-effort variants are collapsed to the best-scoring variant. Hover any point for detail.</figcaption>
      </figure>

      <div class="sub-head"><h3>Projected by provider</h3><p>The same fit applied to each provider&rsquo;s own record setters, against the frontier trend. The chart and table follow the selection above; the summary lines below cover all of them. Providers with too few records to support a curve show no quadratic fit.</p></div>
      ${proj ? projectionBlock(chart, proj, options, activeModel, 'proj-providers', (r) => `data-series="${esc(r.category.id)}"`, false, `Across all ${proj.rows.length} providers, `) : ''}
    </div>
  </section>`;
}

export function renderPage({ config, css, js, dataset, charts, seriesByChart, summary, projections, providers, providerProjection, providerChart }) {
  const { site, source, categories } = config;
  const primary = charts[0];

  const chartSections = charts.map((chart) => {
    const series = [...seriesByChart.get(chart.id).values()];
    return `<section id="${esc(chart.id)}-section">
    <div class="wrap">
      <div class="sec-head"><h2>${esc(chart.title)}</h2><p>${esc(chart.subtitle)}</p></div>
      ${figure(chart, series, config.chart_options, categories)}
    </div>
  </section>`;
  }).join('\n');

  const nav = charts
    .map((c) => `<a href="#${esc(c.id)}-section">${esc(c.yLabel)}</a>`)
    .join('') + '<a href="#projection">Projection</a><a href="#providers">Providers</a><a href="#classes">Classes</a>';

  return `<!doctype html>
<html lang="${esc(site.locale || 'en')}" data-theme="">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(site.title)} — ${esc(site.subtitle)}</title>
<meta name="description" content="${esc(site.description)}">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(site.title)}">
<meta property="og:description" content="${esc(site.description)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%236d1bfc' d='M13.98 16h2v-4h-4v4zM7.98 0 3.99 4H0v4h5.99l3.99-4h2.01V0zM7.98 8l-3.99 4H0v4h5.99l3.99-4h2.01V8zM15.98 8V4h-4v4h4'/%3E%3C/svg%3E">
<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
<style>${css}</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <a class="brand" href="#top">${MARK}${esc(site.title)}</a>
    <nav>${nav}<button class="theme" type="button" aria-label="Toggle colour theme">${SUN}${MOON}</button></nav>
  </div>
</header>

<main id="top">
  <div class="hero"><div class="wrap">
    <span class="eyebrow">Data via ${esc(source.name)} · ${esc(dataset.retrievedAt)}</span>
    <h1>${esc(site.subtitle)}</h1>
    <p class="sub">${esc(site.description)}</p>
    <p class="lede">${esc(site.lede)}</p>
    <div class="meta">
      <span><b>${summary.modelCount}</b> models scored</span>
      <span><b>${summary.openCount}</b> with open weights</span>
      <span><b>${categories.length}</b> deployment classes</span>
      <span>Source: <b>${esc(source.name)}</b></span>
    </div>
  </div></div>

  ${statTiles(summary, primary)}

${chartSections}

  ${projections.size ? `<section id="projection">
    <div class="wrap">
      <div class="sec-head"><h2>When do open weights catch up?</h2><p>A least-squares fit through each class&rsquo;s record-setting releases over the last ${config.projection.lookbackMonths} months, extended forward. Two different questions: when an open class reaches the score the frontier holds <em>today</em>, and whether the open trend is gaining on the frontier trend at all. Both a linear and a quadratic fit are shown for every class; switch models to see how much the answer depends on that choice.</p></div>
      ${charts.filter((c) => projections.has(c.id)).map((c) => projectionBlock(c, projections.get(c.id), { ...config.chart_options, horizonMonths: config.projection.horizonMonths, projectionHeight: config.projection.height }, config.projection.defaultModel ?? 'linear')).join('')}
      <p class="caveat"><strong>Read these as arithmetic, not forecasts.</strong> Both models are straight-line and curved fits through a short, noisy history of a fast-moving field, and the releases they fit are by construction the maxima of their class. A quadratic <em>always</em> fits at least as well as a linear one, so the R\u00b2 columns are not a fair contest on their own \u2014 the F-test beside the quadratic R\u00b2 is what says whether the curvature earns its extra parameter. The &ldquo;reaches&rdquo; column is the sturdier of the two estimates: it depends on one curve. The gap column depends on the <em>difference</em> of two curves, which is far noisier \u2014 under the linear model, where that difference does not clear twice its standard error, no crossing date is quoted.</p>
    </div>
  </section>` : ''}

  ${providers?.length ? providerSection(providerChart, providers, providerProjection, { ...config.chart_options, horizonMonths: config.projection.horizonMonths, projectionHeight: config.providers.projectionHeight ?? config.projection.height, providerHeight: config.providers.height }, config.projection.defaultModel ?? 'linear') : ''}

  <section id="classes">
    <div class="wrap">
      <div class="sec-head"><h2>How the classes are drawn</h2><p>Split by where the weights can actually run. The two consumer tiers are cumulative — ${esc(categories.at(-2).label)} includes everything in “${esc(categories.at(-1).label)}”, because it answers the question “what is the best model I can run within this budget?” Where both tiers share a record holder their lines coincide and the point is annotated once.</p></div>
      ${classCards(categories, seriesByChart.get(primary.id))}
    </div>
  </section>

  <section id="leaders">
    <div class="wrap">
      <div class="sec-head"><h2>Current leaders</h2><p>The standing record holder in each class, as of ${esc(dataset.retrievedAt)}.</p></div>
      ${leaderTable(categories, charts, seriesByChart)}
    </div>
  </section>
</main>

<footer><div class="wrap">
  <div class="row">
    <span>Benchmarks and model metadata from <a href="${esc(source.url)}" rel="noreferrer">${esc(source.name)}</a>.</span>
    <span>Snapshot taken ${esc(dataset.retrievedAt)}.</span>
  </div>
  <p class="fine">${esc(source.note)} Charts show record-setting releases only — a model appears when it beat every earlier model in its class. Reasoning-effort variants of one release are collapsed to the best-scoring variant. This site is not affiliated with ${esc(source.name)}.</p>
</div></footer>

<script>${js}</script>
</body>
</html>`;
}
