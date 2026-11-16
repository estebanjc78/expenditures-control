import type { DatabaseSync } from "node:sqlite";
import type { ForeignMovement, MovementDetail } from "../parsers/types.js";
import type { RateProvider } from "./fx.js";
import type { MovementInput } from "./types.js";

/** A mail the parsers could read but that needs more than a plain insert: kept with its id and bank. */
export interface Pending<T> {
  readonly id: string;
  readonly bank: string;
  readonly subject: string;
  readonly value: T;
}

const DUPLICATE_WINDOW_DAYS = 3;
const DUPLICATE_AMOUNT_TOLERANCE = 0.15; // the bank applies its own rate and fees on top of the official one
const DETAIL_WINDOW_DAYS = 3;

function fold(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** First word of 4+ letters or digits, accents ignored: "ANTHROPIC* CLAUDE" and "Anthropic, PBC" both give "anthropic". */
function firstWord(merchant: string): string | null {
  return /[a-z0-9]{4,}/.exec(fold(merchant))?.[0] ?? null;
}

function alreadyReportedByBank(db: DatabaseSync, f: ForeignMovement, amount: number): boolean {
  const word = firstWord(f.merchant);
  if (!word) return false;
  const rows = db
    .prepare(
      `SELECT merchant FROM movements WHERE kind = ? AND detail IS NULL AND date BETWEEN date(?, '-${DUPLICATE_WINDOW_DAYS} day') AND date(?, '+${DUPLICATE_WINDOW_DAYS} day')
       AND amount BETWEEN ? AND ?`,
    )
    .all(f.kind, f.date, f.date, Math.floor(amount * (1 - DUPLICATE_AMOUNT_TOLERANCE)), Math.ceil(amount * (1 + DUPLICATE_AMOUNT_TOLERANCE))) as { merchant: string }[];
  return rows.some((r) => firstWord(r.merchant) === word);
}

export interface Converted {
  readonly inputs: MovementInput[];
  /** Receipts for charges the bank already reported: nothing to register, not downloaded again. */
  readonly duplicates: { id: string; subject: string }[];
  readonly review: { id: string; subject: string; reason: string }[];
}

/**
 * Turns receipts in another currency into movements in the database currency using that day's official rate,
 * marked as an estimate. A receipt whose charge the bank already reported (same merchant, close date and amount)
 * is skipped, so it is never counted twice. Without a rate it goes to review instead of guessing.
 */
export async function convertForeign(db: DatabaseSync, items: readonly Pending<ForeignMovement>[], rates: RateProvider): Promise<Converted> {
  const inputs: MovementInput[] = [];
  const duplicates: Converted["duplicates"] = [];
  const review: Converted["review"] = [];
  const noRate = new Set<string>(); // currencies whose rate lookup already failed in this run: do not wait on the network again
  for (const { id, bank, subject, value: f } of items) {
    const rate = noRate.has(f.currency) ? null : await rates(f.currency, f.date);
    if (rate === null) {
      noRate.add(f.currency);
      review.push({ id, subject, reason: `Importe en ${f.currency} sin tasa de cambio disponible para ${f.date}: confirma el monto en pesos con el usuario` });
      continue;
    }
    const amount = Math.round(f.value * rate);
    if (amount <= 0) {
      review.push({ id, subject, reason: `Importe en ${f.currency} demasiado pequeño para convertirlo` });
      continue;
    }
    if (alreadyReportedByBank(db, f, amount)) {
      duplicates.push({ id, subject });
      continue;
    }
    const detail = `${f.currency} ${f.value.toFixed(2)} · estimado con la TRM del día`;
    inputs.push({ sourceId: id, bank, date: f.date, amount, merchant: f.merchant, kind: f.kind, detail });
  }
  return { inputs, duplicates, review };
}

const DETAIL_GRACE_DAYS = 30; // after this a receipt with no matching movement is given up, so it stops using the mail quota

export interface DetailOutcome {
  /** Receipts matched to a movement (now described). */
  readonly applied: { id: string; subject: string }[];
  /** Receipts with no single movement to describe yet: kept for the next sync, when the bank's notice may have arrived. */
  readonly waiting: number;
  /** Receipts still unmatched after the grace period: logged as done so they are not downloaded again. */
  readonly abandoned: { id: string; subject: string }[];
}

function matchesMerchant(merchant: string, needles: readonly string[]): boolean {
  const m = fold(merchant);
  return needles.some((n) => m.includes(fold(n)));
}

function dayGap(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Names what an existing movement was for. The receipt matches by amount and date (a few days either way) among
 * the movements whose merchant it can describe, and only when exactly one is the closest: ambiguity changes nothing.
 */
export function applyDetails(db: DatabaseSync, items: readonly Pending<MovementDetail>[], today: string = new Date().toISOString().slice(0, 10)): DetailOutcome {
  const applied: DetailOutcome["applied"] = [];
  const abandoned: DetailOutcome["abandoned"] = [];
  let waiting = 0;
  const find = db.prepare(
    `SELECT id, merchant, date FROM movements WHERE kind = 'gasto' AND amount = ? AND detail IS NULL
     AND date BETWEEN date(?, '-${DETAIL_WINDOW_DAYS} day') AND date(?, '+${DETAIL_WINDOW_DAYS} day')`,
  );
  const set = db.prepare("UPDATE movements SET detail = ? WHERE id = ? AND detail IS NULL");
  for (const { id, subject, value: d } of items) {
    const candidates = (find.all(d.amount, d.date, d.date) as { id: number; merchant: string; date: string }[])
      .filter((c) => matchesMerchant(c.merchant, d.matchMerchant))
      .map((c) => ({ ...c, gap: dayGap(c.date, d.date) }));
    const closest = candidates.length ? Math.min(...candidates.map((c) => c.gap)) : null;
    const best = candidates.filter((c) => c.gap === closest);
    if (best.length === 1) {
      set.run(d.description, best[0]!.id);
      applied.push({ id, subject });
    } else if (dayGap(today, d.date) > DETAIL_GRACE_DAYS) {
      abandoned.push({ id, subject });
    } else {
      waiting += 1;
    }
  }
  return { applied, waiting, abandoned };
}
