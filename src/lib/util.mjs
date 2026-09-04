/** Small shared helpers. */

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ENT[c]);

export const fmt = (n, d = 1) =>
  n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(d).replace(/\.0+$/, d ? '.0' : '');

/**
 * Approximate rendered width of a string, used by the annotation solver.
 * Calibrated against the system sans stack; good to a few percent, which is
 * all the collision test needs.
 */
const NARROW = new Set([...'ijltfrI.,:;\'`!|()[]{}-']);
const WIDE = new Set([...'mwMW@%']);
export function textWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text)) {
    if (ch === ' ') units += 0.28;
    else if (NARROW.has(ch)) units += 0.33;
    else if (WIDE.has(ch)) units += 0.86;
    else if (ch >= 'A' && ch <= 'Z') units += 0.68;
    else if (ch >= '0' && ch <= '9') units += 0.56;
    else units += 0.55;
  }
  return units * fontSize;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
export function monthYear(iso) {
  const [y, m] = String(iso).split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** "14 months" / "1 year 2 months" */
export function humanMonths(months) {
  if (months == null) return '—';
  const total = Math.round(months);
  if (total < 1) return 'under a month';
  if (total < 18) return `${total} month${total === 1 ? '' : 's'}`;
  const y = Math.floor(total / 12);
  const m = total % 12;
  return m ? `${y}y ${m}m` : `${y} year${y === 1 ? '' : 's'}`;
}
