/**
 * Refreshes data/models.json from the Artificial Analysis LLM leaderboard.
 *
 *   npm run fetch
 *
 * The leaderboard is a Next.js app that ships its model tables inside the RSC
 * flight payload (a series of self.__next_f.push([1,"<chunk>"]) calls). We
 * reassemble those chunks and read the two `"models":[...]` arrays it inlines:
 *
 *   - a release index  — slug, name, releaseDate, creator
 *   - the scored table — slug, name, isOpenWeights, intelligenceIndex, prices…
 *
 * They are joined on `slug`. The scored table no longer carries releaseDate,
 * so both are required.
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
  'modelCreatorSlug', 'modelCreatorCountry', 'licenseName', 'huggingfaceUrl',
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

/** Every parseable `"models":[...]` array in the payload. */
function modelArrays(flight) {
  const out = [];
  for (const m of flight.matchAll(/"models":\s*\[/g)) {
    const start = flight.indexOf('[', m.index);
    try {
      const parsed = JSON.parse(sliceArray(flight, start));
      if (Array.isArray(parsed) && parsed.length) out.push(parsed);
    } catch { /* not the array we want */ }
  }
  return out;
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

const arrays = modelArrays(readFlight(await res.text()));
const releases = pickTable(arrays, ['slug', 'releaseDate'], 'release index');
const scored = pickTable(arrays, ['slug', 'intelligenceIndex', 'isOpenWeights'], 'scored model table');

const releaseDates = new Map(releases.map((m) => [m.slug, m.releaseDate]));

const previous = JSON.parse(await readFile(OUT, 'utf8'));
const priorBySlug = new Map(previous.models.map((m) => [m.slug, m]));

const models = scored
  .filter((m) => releaseDates.get(m.slug) && m.intelligenceIndex != null)
  .map((m) => {
    const prior = priorBySlug.get(m.slug) ?? {};
    return {
      ...Object.fromEntries(LIVE.map((f) => [f, m[f] ?? null])),
      releaseDate: releaseDates.get(m.slug),
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
