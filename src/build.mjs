/**
 * Builds dist/ from data/models.json + data/site.yaml.
 *
 *   npm run build
 *
 * Output is a single self-contained HTML file: CSS and the enhancement script
 * are inlined, charts are pre-rendered SVG, and there are no network requests
 * beyond the document itself.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import yaml from 'js-yaml';
import { buildSeries, summarise } from './lib/data.mjs';
import { project, toMonths } from './lib/regress.mjs';
import { renderPage } from './lib/page.mjs';

const url = (p) => new URL(p, import.meta.url);
const read = (p) => readFile(url(p), 'utf8');

/** Strip comments and collapse whitespace — enough for a stylesheet this size. */
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;\}/g, '}')
    .replace(/\s+/g, ' ')
    .trim();
}

function minifyJs(js) {
  return js
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"])\/\/.*$/, '$1').trimEnd())
    .filter((l) => l.trim())
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Emit one `--c` custom property per category, with a dark-theme override, so
 * the pre-rendered SVG and the surrounding chrome recolour with the theme.
 */
function paletteCss(categories) {
  const rule = (scope, c, color) => `${scope}.s-${c.id},${scope}.c-${c.id}{--c:${color}}`;
  const light = categories.map((c) => rule('', c, c.color)).join('') +
    categories.filter((c) => c.lineWidth).map((c) => `.s-${c.id}{--lw:${c.lineWidth}px}`).join('');
  const dark = (scope) =>
    categories.filter((c) => c.colorDark).map((c) => rule(scope, c, c.colorDark)).join('');
  if (!dark('')) return light;
  return light +
    `@media (prefers-color-scheme:dark){${dark(':root:not([data-theme="light"]) ')}}` +
    dark(':root[data-theme="dark"] ');
}

const config = yaml.load(await read('../data/site.yaml'));
const dataset = JSON.parse(await read('../data/models.json'));
const models = dataset.models;

const { categories, charts, chart_options: options } = config;

// One series set per chart, keyed by category id.
const seriesByChart = new Map(
  charts.map((chart) => [
    chart.id,
    new Map(buildSeries(models, categories, chart.metric).map((s) => [s.id, s])),
  ]),
);

// Catch-up projections, one per chart.
const now = toMonths(dataset.retrievedAt);
const projections = new Map();
if (config.projection?.enabled) {
  for (const chart of charts) {
    const p = project(seriesByChart.get(chart.id), categories, config.projection, now);
    if (p) projections.set(chart.id, p);
  }
}

const summary = summarise(models, seriesByChart.get(charts[0].id), charts[0].metric);

const html = renderPage({
  config,
  css: minifyCss(await read('./styles.css')) + paletteCss(categories),
  js: minifyJs(await read('./assets/app.js')),
  dataset,
  charts,
  seriesByChart,
  summary,
  projections,
});

const out = url('../dist/');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(new URL('index.html', out), html);
// Ship the source data alongside the page so the numbers are auditable.
await writeFile(new URL('models.json', out), JSON.stringify(dataset));

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(`dist/index.html   ${kb(Buffer.byteLength(html))}`);
for (const chart of charts) {
  const counts = [...seriesByChart.get(chart.id).values()]
    .map((s) => `${s.id}:${s.points.length}`)
    .join('  ');
  console.log(`  ${chart.id.padEnd(13)} ${counts}`);
}
