// Shared normalization for customer-entered data so it's stored consistently.
// Applied at every customer WRITE point (create/edit), retail + trade.
// Rules: Smart Title Case names, US phone formatted as (XXX) XXX-XXXX,
// email lowercased, state upper, middle initial upper, whitespace collapsed.

// Title-case a single word: leaves short all-caps tokens (initials like "QW")
// alone, capitalizes after an apostrophe (O'Brien), and fixes Mc-names (McDonald).
function capWord(w) {
  if (!w) return w;
  if (w.length <= 3 && /^[A-Z]+$/.test(w)) return w; // initials / acronyms
  let x = w.toLowerCase();
  x = x.replace(/(^|['’])([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());
  x = x.replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase());
  return x;
}

// Smart Title Case across spaces and hyphens (Mary-Jane, Van Der Berg stays sane).
export function titleCaseName(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!s) return s;
  return s.split(' ').map(word => word.split('-').map(capWord).join('-')).join(' ');
}

// US phone -> "(714) 555-1234". Strips a leading US country code. Anything that
// isn't a clean 10-digit number is left as typed (don't corrupt odd input).
export function formatPhone(raw) {
  if (raw == null || raw === '') return raw;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return String(raw).trim();
}

// Middle initial -> uppercase, letters/period only, capped.
export function normMiddleInitial(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase().slice(0, 4);
  return s || null;
}

export function normEmail(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return s || null;
}

// 2-letter state code -> uppercase; other text trimmed as-is.
export function normState(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  return s.length === 2 ? s.toUpperCase() : s;
}

// Trim + collapse internal whitespace; no case change (company/address own their casing).
export function collapse(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  return s || null;
}
