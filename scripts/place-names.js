// Name normalisation shared by the gazetteer builder and the inspection-location sync.
const SUFFIX = /\s+(city and county|city|town|cdp|municipality|village|borough)$/i;

// "Cañon City city" -> "CANON CITY"; punctuation and repeated spaces dropped. Leaves a trailing "CITY"/"VILLAGE" alone
// unless stripSuffix is set, because inspection records say "COMMERCE CITY CO", not "Commerce City".
export function cleanName(s, { stripSuffix = false } = {}) {
  const base = String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const name = stripSuffix ? base.replace(SUFFIX, '') : base;
  return name.replace(/[^A-Za-z0-9 -]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}
