# llm-stats

A static site charting the **LLM capability frontier by deployment class** — how the
best open-weight model you can actually run compares to the closed frontier, over time.

Two charts, four lines each:

| Class | Definition |
| --- | --- |
| Frontier | Closed-weight, API-only models |
| Data-center open weights | Open weights ≥ 120B total parameters |
| Open weights < 120B | Open weights under 120B (cumulative — includes the tier below) |
| Open weights ≤ 27B | The single-GPU tier |

Each point is a **record setter**: a model that beat every earlier release in its class.

A third section fits each class's recent records and projects when open weights
reach the frontier's current score — see [Projection](#projection) below.

Data comes from [Artificial Analysis](https://artificialanalysis.ai/leaderboards/models).

## Use

```bash
npm install
npm run build     # data/ -> dist/
npm run serve     # preview at http://localhost:4321  (Ctrl-C to stop)
```

`npm run refresh` re-scrapes Artificial Analysis and rebuilds in one step.

If `npm run serve` reports the port is in use, an earlier preview is still
running. Stop it, or pick another port:

```bash
kill $(lsof -t -iTCP:4321 -sTCP:LISTEN)
```

```bash
PORT=4322 npm run serve
```

## Updating

Everything on the page is generated from two files.

**`data/models.json`** — the model records. Refresh from Artificial Analysis with:

```bash
npm run fetch
```

That rewrites the file in place. You can also hand-edit it or swap in your own
data; the build only requires `name`, `releaseDate`, `isOpenWeights`,
`totalParameters` (billions) and whichever metric fields your charts reference.

**Payload shape moves often.** Artificial Analysis restructured the leaderboard
payload twice in September 2026. Release dates are no longer inline on the model
index; `npm run fetch` now resolves them through `releaseSlug` into a separate
`releases` table, and falls back to the older inline shape if it reappears. It
reports which shape it used and how many models it resolved, so a silent partial
join is visible. If it reports far fewer dates than models, the payload moved again.

**Carried-forward fields.** As of the 2026-09-18 snapshot, Artificial Analysis
no longer publishes `totalParameters`, `activeParameters`, `codingIndex`,
`agenticIndex`, `licenseName` or `huggingfaceUrl` on the leaderboard — the
parameter counts are now only a coarse `paramClass` bucket (`tiny`/`small`/
`medium`/`large`). `npm run fetch` copies those fields forward by `slug` from
the previous `data/models.json` rather than dropping them, and lists them in the
file's `carriedFields`. Two consequences:

- **Parameter counts** are a fixed property of a release, so carrying them is
  sound — but **models added since the change have none**, and a model with no
  `totalParameters` cannot match a size-bounded category, so it is invisible to
  the open-weight tiers. Fill `totalParameters` in by hand to place one.
- **`codingIndex` and `agenticIndex` are frozen** at the last snapshot that
  carried them (2026-09-04). The coding chart still renders, but it gains no new
  points and its scores are on the *old* index scale — see the warning below.
  Its figures in this file are therefore unchanged between snapshots by
  construction, not by coincidence.

**The Intelligence Index was rebased** in that same change: every model's score
moved (mean −6.3 points, the frontier top from 65.7 to 53.4). The intelligence
chart is internally consistent because all 643 models were refetched on the new
scale, but **intelligence and coding numbers are no longer comparable to each
other**, and any figure quoted from a pre-2026-09-18 snapshot is on the old scale.

**`data/site.yaml`** — everything else: category thresholds and colours, which
charts exist, axis labels, and page copy. Some things you can change there:

- **Add a chart.** Append to `charts:` with any numeric field in `models.json`
  as its `metric` (e.g. `agenticIndex`). A new section appears automatically.
- **Change a threshold.** Edit `match.maxParams` / `match.minParams`.
- **Change the size tiers.** The two consumer tiers are cumulative by default,
  so "< 120B" answers *what is the best model I can run within this budget?*
  and includes the 27B tier. Where both share a record holder the lines coincide
  and the point is labelled once. Add `minParams: 28` to `lt120` for a distinct
  band instead.
- **Note on the 27B bound.** `lt27` uses `maxParams: 28` because models branded
  "27B" report 27.8B parameters; a strict `27` drops Qwen3.5/3.6 27B and costs
  the class ~26 index points. Set it to `27` if you want the literal cutoff.
- **Drop the score from annotations.** Set `chart_options.showScores: false`.
- **Clip the x-axis.** Set `chart_options.minDate` to a date; earlier records
  carry in at the left edge.
- **Tune the projection.** `projection.lookbackMonths` sets the fit window
  (default 24), `horizonMonths` how far ahead it is drawn, and
  `projection.enabled: false` removes the section entirely.

Then run `npm run build`.

## Output

`dist/index.html` is fully self-contained — CSS and the enhancement script are
inlined and the charts are pre-rendered SVG, so the page makes **no network
requests at all** beyond the document. No fonts are fetched (system stack), no
charting library ships to the browser, and nothing is laid out at runtime.
`dist/models.json` is written alongside it so the numbers stay auditable.

JavaScript only adds the theme toggle, series toggles and hover tooltips; with
it disabled the charts still render completely and every point keeps a native
`<title>` tooltip.

Deploy `dist/` to any static host.

## Layout

```
data/models.json    model records (generated; safe to regenerate)
data/site.yaml      categories, charts, copy — the knob you turn
scripts/fetch-aa.mjs  refresh models.json from Artificial Analysis
scripts/serve.mjs   local preview server
src/build.mjs       build entry point
src/lib/data.mjs    categorisation + record-setter computation
src/lib/chart.mjs   SVG renderer and annotation placement
src/lib/page.mjs    document assembly
src/styles.css      stylesheet (inlined at build)
src/assets/app.js   progressive enhancement (inlined at build)
```

Not affiliated with Artificial Analysis.

## Projection

<a id="projection"></a>The projection section fits each class's record-setting
releases inside a recent window (24 months by default) with **both a linear and
a quadratic model**, and answers two separate questions:

1. **When does an open class reach the score the frontier holds today?**
   Depends on a single curve, and is the sturdier of the two estimates.
2. **Is the open trend gaining on the frontier trend?** Depends on the
   *difference* of two curves, which is much noisier.

A toggle above each chart switches models. Both fits are computed at build time
and pre-rendered, so switching is a CSS class change — nothing is recomputed in
the browser, and the page defaults to linear without JavaScript.

### Comparing the two models

Figures below are from the 2026-09-29 snapshot; rerun `npm run refresh` and they move.

A quadratic always fits at least as well as a linear one, so raw R² is not a
fair contest. Each series is therefore compared with an **F-test on the
curvature term** (α = 0.05), shown beside the quadratic R²:

| Metric | Linear R² | Quadratic R² | Curvature |
| --- | --- | --- | --- |
| Intelligence — frontier | 0.936 | 0.987 | F=66.9 — **significant** |
| Intelligence — data-center | 0.881 | 0.973 | F=48.5 — **significant** |
| Intelligence — < 120B | 0.840 | 0.963 | F=20.0 — **significant** |
| Intelligence — ≤ 27B | 0.933 | 0.990 | F=24.3 — **significant** |
| Coding — frontier | 0.958 | 0.966 | F=2.1 — not significant |
| Coding — data-center | 0.952 | 0.966 | F=2.9 — not significant |
| Coding — < 120B | 0.850 | 0.902 | F=2.7 — not significant |
| Coding — ≤ 27B | 0.819 | 0.908 | F=2.9 — not significant |

So on **intelligence** the curvature is real and the quadratic is the better
model; on **coding** the R² gain is what you would expect from an extra
parameter alone, and the linear fit is the defensible one. Coding simply has
fewer record-setters (n = 6–11) to resolve curvature with.

The curvature is positive throughout — these trends are accelerating — so the
quadratic model puts every catch-up date months earlier than the linear one:

| | Linear | Quadratic |
| --- | --- | --- |
| Data-center reaches 57.6 | Aug 2027 | Dec 2026 |
| < 120B reaches 57.6 | Jul 2028 | Mar 2027 |
| ≤ 27B reaches 57.6 | Feb 2028 | Mar 2027 |
| Trends meet | not separable | Feb 2031 (data-center) |

That spread *is* the result: on this data the answer to "when do open weights
catch up?" depends as much on the model you pick as on the data itself.

Under the linear model the gap verdict additionally requires the slope
difference to clear 2×SE before any crossing date is quoted — without that
guard the same data yields crossovers anywhere from 2028 to 2073 depending only
on the fit window.

These are extrapolations of short histories in a fast-moving field, fitted to
points that are by construction the maxima of their class. Treat them as
arithmetic, not forecasts.

## By provider

A third section plots **every scored model grouped by who made it** — faint dots
for a provider's whole catalogue, a solid line through their own record setters —
and applies the same projection per provider against the frontier trend.

The checkbox list picks which providers appear, in both the history chart and the
projection chart and table. All providers are pre-rendered and hidden with CSS,
so toggling costs nothing at runtime; with JavaScript off the default selection
still renders.

Defaults to the **5 providers with the most scored models** (Alibaba, OpenAI,
Google, Anthropic, DeepSeek). "Most popular" has no objective definition, so
that proxy is the honest one — override it with an explicit list:

```yaml
providers:
  featured: [OpenAI, Anthropic, Google, Meta, DeepSeek]
```

Other knobs in `data/site.yaml`:

- `metric` — any numeric field in `models.json`
- `minModels` / `maxProviders` — how much of the long tail to include
  (default: ≥ 3 scored models, capped at 24, ranked by model count)
- `defaultCount` — how many are ticked on load when `featured` is empty
- `palette` / `paletteDark` — cycled in rank order, so the default selection
  always gets distinct colours

The summary lines under the provider projection describe **all** providers, not
just the ticked ones, since they are static text; the chart and table follow the
selection.
