/**
 * Refreshes data/models.json from the Artificial Analysis LLM leaderboard.
 *
 *   npm run fetch
 *
 * The leaderboard is a Next.js app that ships its model tables inside the RSC
 * flight payload (a series of self.__next_f.push([1,"<chunk>"]) calls). We
 * reassemble those chunks and read the tables it inlines:
 *
 *   - the scored table  `"models":[…]`  — slug, isOpenWeights, intelligenceIndex, prices…
 *   - a model index     `"models":[…]`  — slug, name, releaseSlug
 *   - a release table   `"releases":[…]` — slug, releaseDate, creator
 *
 * The scored table carries no date, so the release date is resolved per model.
 * Upstream has moved it twice, so both known shapes are supported:
 *
 *   a) releaseDate inline on the model index row          (before 2026-09-29)
 *   b) model index row -> releaseSlug -> releases[].slug  (current)
 *
 * Whichever resolves more of the scored table wins; see resolveReleaseDates.
 *
 * CARRIED-FORWARD FIELDS
 * Artificial Analysis stopped publishing several fields this site charts —
 * notably totalParameters/activeParameters (now only the coarse `paramClass`
 * bucket) and codingIndex/agenticIndex. Those are copied from the existing
 * data/models.json by slug rather than dropped, so a refresh never loses data
 * the page depends on. Parameter counts are properties of a release and do not
 * go stale; the carried indices are frozen at whatever snapshot last had them,
 * and new models have none. See CARRIED in the source below.
 */
import { readFile, writeFile } from 'node:fs/promises';

const SOURCE = 'https://artificialanalysis.ai/leaderboards/models';
const OUT = new URL('../data/models.json', import.meta.url);

/** Fields read straight from the upstream scored table. */
const LIVE = [
  'name', 'slug', 'isReasoning', 'deprecated', 'modelCreatorName',
  'intelligenceIndex', 'intelligenceIndexIsEstimated',
  'isOpenWeights', 'paramClass', 'contextWindowTokens',
  'price1mInputTokens', 'price1mOutputTokens', 'medianOutputTokensPerSecond',
];

/** Fields upstream no longer publishes; preserved from the previous snapshot. */
const CARRIED = [
  'totalParameters', 'activeParameters', 'codingIndex', 'agenticIndex',
  'modelCreatorCountry', 'licenseName', 'huggingfaceUrl',
];

/** Refuse to overwrite a good snapshot with a much smaller one. */
const MIN_RETAINED = 0.9;

/** Reassemble the RSC flight payload from the inlined script chunks. */
function readFlight(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)];
  if (!chunks.length) throw new Error('No RSC payload found — the page structure changed.');
  return chunks.map((m) => JSON.parse(m[1])).join('');
}

/** Extract the JSON array starting at `start` by matching brackets outside of strings. */
function sliceArray(text, start) {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (--depth === 0) return text.slice(start, i + 1); }
  }
  throw new Error('Unterminated models array in payload.');
}

/** Every parseable non-empty array inlined under `"<key>":[...]`. */
function arraysNamed(flight, key) {
  const out = [];
  for (const m of flight.matchAll(new RegExp(`"${key}":\\s*\\[`, 'g'))) {
    const start = flight.indexOf('[', m.index);
    try {
      const parsed = JSON.parse(sliceArray(flight, start));
      if (Array.isArray(parsed) && parsed.length) out.push(parsed);
    } catch { /* not the array we want */ }
  }
  return out;
}

/**
 * Map each scored model's slug to its release date, trying both known payload
 * shapes and keeping whichever resolves more rows.
 *
 * `releases` may be absent (shape a) — then the model index carries the date
 * itself. Also returns the creator record where the release table supplies one.
 */
function resolveReleaseDates(index, releases, scored) {
  const wanted = new Set(scored.map((m) => m.slug));
  const byRelease = new Map(releases.map((r) => [r.slug, r]));

  const inline = new Map();
  const viaRelease = new Map();
  for (const row of index) {
    if (!wanted.has(row.slug)) continue;
    if (row.releaseDate) inline.set(row.slug, { releaseDate: row.releaseDate, creator: row.creator ?? null });
    const rel = row.releaseSlug != null ? byRelease.get(row.releaseSlug) : null;
    if (rel?.releaseDate) viaRelease.set(row.slug, { releaseDate: rel.releaseDate, creator: rel.creator ?? null });
  }

  const [shape, dates] = viaRelease.size >= inline.size
    ? ['releaseSlug -> releases[]', viaRelease]
    : ['inline on the model index', inline];
  if (!dates.size) {
    throw new Error('Could not resolve any release dates — the page structure changed.');
  }
  return { shape, dates };
}

/** Pick the largest array whose rows carry every one of `keys`. */
function pickTable(arrays, keys, what) {
  const hit = arrays
    .filter((a) => keys.every((k) => k in a[0]))
    .sort((a, b) => b.length - a.length)[0];
  if (!hit) throw new Error(`Could not locate the ${what} in the payload — the page structure changed.`);
  return hit;
}

const res = await fetch(SOURCE, {
  headers: {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
  },
});
if (!res.ok) throw new Error(`${SOURCE} responded ${res.status}`);

const flight = readFlight(await res.text());
const modelArrays = arraysNamed(flight, 'models');
const scored = pickTable(modelArrays, ['slug', 'intelligenceIndex', 'isOpenWeights'], 'scored model table');
const index = pickTable(modelArrays, ['slug', 'name'], 'model index');
const releases = arraysNamed(flight, 'releases').sort((a, b) => b.length - a.length)[0] ?? [];

const { shape, dates } = resolveReleaseDates(index, releases, scored);
console.log(`Release dates resolved via ${shape} (${dates.size}/${scored.length} scored models).`);

const previous = JSON.parse(await readFile(OUT, 'utf8'));
const priorBySlug = new Map(previous.models.map((m) => [m.slug, m]));

const models = scored
  .filter((m) => dates.has(m.slug) && m.intelligenceIndex != null)
  .map((m) => {
    const prior = priorBySlug.get(m.slug) ?? {};
    const { releaseDate, creator } = dates.get(m.slug);
    return {
      ...Object.fromEntries(LIVE.map((f) => [f, m[f] ?? null])),
      releaseDate,
      modelCreatorSlug: creator?.slug ?? prior.modelCreatorSlug ?? null,
      ...Object.fromEntries(CARRIED.map((f) => [f, prior[f] ?? null])),
    };
  })
  .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.name.localeCompare(b.name));

// A schema change upstream should fail loudly, not quietly empty the file.
if (!models.length) throw new Error('Extracted 0 models — refusing to overwrite data/models.json.');
const retained = models.filter((m) => priorBySlug.has(m.slug)).length;
if (retained < previous.models.length * MIN_RETAINED) {
  throw new Error(
    `Only ${retained} of ${previous.models.length} known models survived the refresh ` +
    `(threshold ${Math.ceil(previous.models.length * MIN_RETAINED)}) — refusing to overwrite data/models.json.`,
  );
}

const payload = {
  source: 'Artificial Analysis',
  sourceUrl: SOURCE,
  retrievedAt: new Date().toISOString().slice(0, 10),
  note: 'totalParameters and activeParameters are in billions. Scores are Artificial Analysis index values (0-100).',
  carriedFields: CARRIED,
  carriedNote:
    'Artificial Analysis no longer publishes these fields; they are carried forward by slug from the ' +
    'previous snapshot. Parameter counts are fixed properties of a release; codingIndex and agenticIndex ' +
    'are frozen at the last snapshot that carried them and are absent for models added since.',
  models,
};

await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');

const fresh = models.length - retained;
const missing = CARRIED.filter((f) => models.every((m) => m[f] == null));
console.log(`Wrote ${models.length} models to data/models.json (retrieved ${payload.retrievedAt}).`);
console.log(`  ${retained} refreshed, ${fresh} new, ${previous.models.length - retained} dropped upstream.`);
for (const f of CARRIED) {
  const n = models.filter((m) => m[f] != null).length;
  if (n) console.log(`  carried ${f}: ${n}/${models.length}`);
}
if (missing.length) console.log(`  no values carried for: ${missing.join(', ')}`);
