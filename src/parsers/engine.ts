import { cleanText } from "../domain/sanitize.js";
import { parseMoney } from "./amount.js";
import { parseDateText } from "./date.js";
import { readFields } from "./fields.js";
import { DATABASE_CURRENCY } from "./profile.js";
import type { BankProfile, Extractor, ProfileTemplate } from "./profile.js";
import { safeMatch } from "./safe-regex.js";
import { normalizeEmailText } from "./text.js";
import { localDate } from "./types.js";
import type { ParseResult, ParserInput } from "./types.js";

const MAX_VALUE_CHARS = 160;
const MAX_MERCHANT_CHARS = 80;
const MAX_DETAIL_CHARS = 120; // a product description is longer than a merchant name

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function applies(t: ProfileTemplate, subject: string, text: string): boolean {
  const subjectOk = !t.subjectContains?.length || t.subjectContains.some((s) => subject.includes(fold(s)));
  const bodyOk = !t.bodyContains?.length || t.bodyContains.every((s) => text.includes(fold(s)));
  return subjectOk && bodyOk;
}

function cutAtMarkers(text: string, markers: readonly string[]): string {
  let end = text.length;
  const folded = fold(text);
  for (const m of markers) {
    const at = folded.indexOf(fold(m));
    if (at >= 0 && at < end) end = at;
  }
  return text.slice(0, end);
}

function labelsOf(t: ProfileTemplate): string[] {
  const own = [t.amount, t.merchant, t.date].flatMap((e) => (e && "label" in e ? [e.label] : []));
  return [...own, ...(t.delimiters ?? [])];
}

function valueOf(extractor: Extractor | undefined, fields: Map<string, string>, text: string): string | null {
  if (!extractor) return null;
  if ("fixed" in extractor) return extractor.fixed;
  if ("label" in extractor) {
    const raw = fields.get(extractor.label.toLowerCase());
    return raw ? raw.slice(0, MAX_VALUE_CHARS).trim() : null;
  }
  return safeMatch(extractor.regex, text)?.trim() ?? null;
}

/**
 * Runs a learned bank profile over one notice. Works on text only (no model): the first template that applies
 * decides whether the mail is skipped or which fields to read; anything it cannot read is "unrecognized".
 */
export function runProfile(profile: BankProfile, input: ParserInput): ParseResult {
  const text = normalizeEmailText(input.text);
  const subject = fold(input.subject);
  const template = profile.templates.find((t) => applies(t, subject, fold(text)));
  if (!template) return { status: "unrecognized" };
  if (template.action === "skip") return { status: "skip", reason: template.skipReason ?? `Plantilla "${template.name}": no es un movimiento` };

  const scoped = cutAtMarkers(text, [...profile.endMarkers, ...(template.endMarkers ?? [])]);
  const fields = readFields(scoped, labelsOf(template), false);

  const money = parseMoney(valueOf(template.amount, fields, scoped) ?? "", profile.currency);
  const merchant = cleanText(valueOf(template.merchant, fields, scoped) ?? "", template.action === "detail" ? MAX_DETAIL_CHARS : MAX_MERCHANT_CHARS);
  if (!money || !merchant) return { status: "unrecognized" };

  const rawDate = template.date ? valueOf(template.date, fields, scoped) : null;
  const date = template.date ? (rawDate ? parseDateText(rawDate, profile.dateFormats) : null) : localDate(input.receivedAt, profile.timezone);
  if (!date) return { status: "unrecognized" };

  if (template.action === "detail") {
    const amount = Math.round(money.value);
    if (money.currency !== profile.currency || amount <= 0) return { status: "unrecognized" };
    return { status: "detail", detail: { date, amount, description: merchant, matchMerchant: template.matchMerchant ?? [] } };
  }

  if (!template.kind) return { status: "unrecognized" };
  const home = profile.foreignCurrency === "convert" ? DATABASE_CURRENCY : profile.currency;
  if (money.currency !== home) {
    if (profile.foreignCurrency === "convert" && money.value > 0) {
      return { status: "foreign", foreign: { date, merchant, kind: template.kind, currency: money.currency, value: money.value } };
    }
    return { status: "review", reason: `Importe en otra moneda (${money.currency}): no se registra sin confirmar con el usuario` };
  }
  const amount = Math.round(money.value);
  if (amount <= 0) return { status: "unrecognized" };

  return { status: "movement", movement: { date, amount, merchant, kind: template.kind } };
}
