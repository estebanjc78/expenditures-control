import type { Category, Kind } from "../domain/types.js";

export interface ParserInput {
  readonly subject: string;
  /** Mail body, HTML or plain text. */
  readonly text: string;
  /** Mail received time, epoch milliseconds. */
  readonly receivedAt: number;
}

export interface ParsedMovement {
  readonly date: string; // YYYY-MM-DD, Colombian local date
  readonly amount: number; // COP, integer
  readonly merchant: string;
  readonly kind: Kind;
  /** Category to use when the user has no rule for this merchant. */
  readonly suggestedCategory?: Category;
}

/** A movement whose amount is in another currency: the caller converts it to the database currency. */
export interface ForeignMovement {
  readonly date: string;
  readonly merchant: string;
  readonly kind: Kind;
  readonly currency: string; // ISO 4217
  readonly value: number; // in `currency`
}

/** A receipt that names what a charge was for, to be matched with a movement that already exists. */
export interface MovementDetail {
  readonly date: string;
  readonly amount: number;
  readonly description: string;
  /** Only movements whose merchant contains one of these (accents and case ignored) can be matched. */
  readonly matchMerchant: readonly string[];
}

export type ParseResult =
  | { readonly status: "movement"; readonly movement: ParsedMovement }
  | { readonly status: "foreign"; readonly foreign: ForeignMovement }
  /** Not a movement: it adds a description to a movement that another sender already reported. */
  | { readonly status: "detail"; readonly detail: MovementDetail }
  /** A mail that is known not to be a movement (rejected purchase, duplicate notice). */
  | { readonly status: "skip"; readonly reason: string }
  /** A real movement the parser will not guess (foreign currency): the user decides. */
  | { readonly status: "review"; readonly reason: string }
  | { readonly status: "unrecognized" };

export type Parser = (input: ParserInput) => ParseResult;

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000; // Colombia is UTC-5 all year (no DST)

/** Colombian local calendar date (YYYY-MM-DD) of an instant. */
export function bogotaDate(epochMs: number): string {
  return new Date(epochMs - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Calendar date (YYYY-MM-DD) of an instant in any IANA time zone, e.g. "America/Argentina/Buenos_Aires". */
export function localDate(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochMs));
}
