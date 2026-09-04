/**
 * Refreshes data/models.json from the Artificial Analysis LLM leaderboard.
 *
 *   npm run fetch
 *
 * The leaderboard is a Next.js app that ships its full model table inside the
 * RSC flight payload (a series of self.__next_f.push([1,"<chunk>"]) calls).
 * We reassemble those chunks, pull out the `{"models":[...]}` array, and keep
 * only the fields the site actually charts.
 */
import { writeFile } from 'node:fs/promises';

const SOURCE = 'https://artificialanalysis.ai/leaderboards/models';
const OUT = new URL('../data/models.json', import.meta.url);

const FIELDS = [
  'name', 'slug', 'releaseDate', 'isReasoning', 'deprecated',
  'modelCreatorName', 'modelCreatorSlug', 'modelCreatorCountry',
  'intelligenceIndex', 'intelligenceIndexIsEstimated', 'codingIndex', 'agenticIndex',
  'isOpenWeights', 'totalParameters', 'activeParameters',
  'contextWindowTokens', 'licenseName', 'huggingfaceUrl',
  'price1mInputTokens', 'price1mOutputTokens', 'medianOutputTokensPerSecond',
];

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

/**
 * Find the leaderboard table in the payload. The page inlines two `"models":[...]`
 * arrays of equal length — a lightweight one for the nav dropdown and the full
 * scored table — so we select on the presence of the metric fields, not on size.
 */
function extractModels(flight) {
  let best = null;
  for (const m of flight.matchAll(/"models":\s*\[/g)) {
    const start = flight.indexOf('[', m.index);
    let parsed;
    try { parsed = JSON.parse(sliceArray(flight, start)); } catch { continue; }
    if (!Array.isArray(parsed) || !parsed.length) continue;
    if (!('intelligenceIndex' in parsed[0]) || !('isOpenWeights' in parsed[0])) continue;
    if (!best || parsed.length > best.length) best = parsed;
  }
  if (!best) throw new Error('Could not locate the scored model table in the payload.');
  return best;
}

const res = await fetch(SOURCE, {
  headers: {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
  },
});
if (!res.ok) throw new Error(`${SOURCE} responded ${res.status}`);

const models = extractModels(readFlight(await res.text()))
  .filter((m) => m.releaseDate && m.intelligenceIndex != null)
  .map((m) => Object.fromEntries(FIELDS.map((f) => [f, m[f] ?? null])))
  .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.name.localeCompare(b.name));

const payload = {
  source: 'Artificial Analysis',
  sourceUrl: SOURCE,
  retrievedAt: new Date().toISOString().slice(0, 10),
  note: 'totalParameters and activeParameters are in billions. Scores are Artificial Analysis index values (0-100).',
  models,
};

await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n');
console.log(`Wrote ${models.length} models to data/models.json (retrieved ${payload.retrievedAt}).`);
