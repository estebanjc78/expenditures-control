import type { DatabaseSync } from "node:sqlite";

/** Rate to turn one unit of `currency` into the database currency (COP) on `date` (YYYY-MM-DD), or null when unknown. */
export type RateProvider = (currency: string, date: string) => Promise<number | null>;

const TRM_URL = "https://www.datos.gov.co/resource/32sa-8pi3.json";
const REQUEST_TIMEOUT_MS = 8000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_PLAUSIBLE_RATE = 100;
const MAX_PLAUSIBLE_RATE = 100_000;

function cachedRate(db: DatabaseSync, currency: string, date: string): number | null {
  const row = db.prepare("SELECT rate FROM fx_rates WHERE currency = ? AND date = ?").get(currency, date) as { rate: number } | undefined;
  return row ? Number(row.rate) : null;
}

async function fetchTrm(date: string, fetchFn: typeof fetch): Promise<number | null> {
  // Only a date and a public dataset name leave the computer: no account, merchant or amount data.
  const params = new URLSearchParams({
    $where: `vigenciadesde<='${date}T00:00:00.000'`,
    $order: "vigenciadesde DESC",
    $limit: "1",
  });
  const response = await fetchFn(`${TRM_URL}?${params.toString()}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) return null;
  const rows: unknown = await response.json();
  const value = Array.isArray(rows) ? Number((rows[0] as { valor?: unknown } | undefined)?.valor) : Number.NaN;
  return Number.isFinite(value) && value >= MIN_PLAUSIBLE_RATE && value <= MAX_PLAUSIBLE_RATE ? value : null;
}

/**
 * Official Colombian exchange rate (TRM, Banco de la República via datos.gov.co) for USD, cached per day in the
 * database (a weekend or holiday uses the latest published rate, as the bank does). Any other currency, a bad date or a network failure gives null, so the caller can ask the user instead.
 */
export function trmRateProvider(db: DatabaseSync, fetchFn: typeof fetch = fetch): RateProvider {
  return async (currency, date) => {
    if (currency !== "USD" || !DATE_RE.test(date)) return null;
    const hit = cachedRate(db, currency, date);
    if (hit !== null) return hit;
    let rate: number | null;
    try {
      rate = await fetchTrm(date, fetchFn);
    } catch {
      return null;
    }
    if (rate !== null) {
      try {
        db.prepare("INSERT OR REPLACE INTO fx_rates (currency, date, rate) VALUES (?, ?, ?)").run(currency, date, rate);
      } catch {
        // the cache is only an optimisation: the rate is still good
      }
    }
    return rate;
  };
}
