import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.js";
import { dashboardData } from "../src/domain/dashboard.js";
import { addMovement } from "../src/domain/movements.js";
import { parseProfile, saveProfile, sampleSchema, testProfile } from "../src/domain/profiles.js";
import { addSender } from "../src/domain/senders.js";
import { syncMail } from "../src/domain/sync.js";
import type { RateProvider } from "../src/domain/fx.js";
import type { MailMessage, MailSource } from "../src/gmail/source.js";
import { parseDateText } from "../src/parsers/date.js";
import { runProfile } from "../src/parsers/engine.js";

// Made-up software shop that bills in dollars from a different sender than the user's bank.
const SAAS_SENDER = "facturas@mail.ejemplo-saas.test";
const SAAS = parseProfile({
  bank: "ejemplosaas",
  currency: "USD",
  foreignCurrency: "convert",
  dateFormats: ["MMM D, YYYY"],
  templates: [
    {
      name: "recibo",
      subjectContains: ["Your receipt from Ejemplo SaaS"],
      kind: "gasto",
      amount: { regex: "Receipt from Ejemplo SaaS \\$([\\d.,]+)" },
      merchant: { fixed: "Ejemplo SaaS" },
      date: { regex: "Paid on ([A-Za-z]+ \\d{1,2}, \\d{4})" },
    },
    { name: "otros avisos", subjectContains: ["unsuccessful", "Security alert"], action: "skip", skipReason: "No es un cobro" },
  ],
});
const saasReceipt = (amount: string, paid: string): string =>
  `Ejemplo SaaS Receipt from Ejemplo SaaS $${amount} Paid on ${paid} with - 1234 Receipt #1111-2222 Plan Pro Qty 1 $${amount} Total $${amount}`;

// Made-up app store whose receipts name the product a card charge was for.
const STORE_SENDER = "no_reply@email.tiendaejemplo.test";
const STORE = parseProfile({
  bank: "tiendaejemplo",
  currency: "COP",
  dateFormats: ["DD/MM/YYYY"],
  templates: [
    {
      name: "recibo con detalle",
      subjectContains: ["Tu recibo"],
      action: "detail",
      matchMerchant: ["tiendaejemplo.com/bill"],
      amount: { regex: "TOTAL \\$ ?([\\d.,]+)" },
      date: { label: "FECHA DEL RECIBO" },
      merchant: { regex: "DOCUMENTO \\d+ (.{3,100}?) Reportar un problema" },
      delimiters: ["ID DEL PEDIDO"],
    },
  ],
});
const storeReceipt = (date: string, product: string, total: string): string =>
  `Factura CUENTA FACTURADO A Visa .... 1234 Persona Ejemplo Calle 1 Bogota COL FECHA DEL RECIBO ${date} ID DEL PEDIDO ABC123 NÚMERO DE DOCUMENTO 555000 ${product} Reportar un problema $ ${total} Incluye 19 % de IVA TOTAL $ ${total}`;

const RECEIVED = Date.parse("2026-11-05T15:00:00Z");
const mail = (id: string, from: string, subject: string, body: string): MailMessage => ({ id, from, subject, body, receivedAt: RECEIVED });

class FakeSource implements MailSource {
  readonly fetched: string[] = [];
  constructor(private readonly messages: readonly MailMessage[]) {}
  async listMessageIds(_q: string, limit: number): Promise<string[]> {
    return this.messages.slice(0, limit).map((m) => m.id);
  }
  async getMessage(id: string): Promise<MailMessage> {
    this.fetched.push(id);
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  }
}

const rates =
  (value: number | null): RateProvider =>
  async () =>
    value;

describe("dates written month first", () => {
  it("reads 'November 5, 2026' and 'Nov 5 2026'", () => {
    expect(parseDateText("Paid on November 5, 2026 with VISA", ["MMM D, YYYY"])).toBe("2026-11-05");
    expect(parseDateText("Mar 3, 2025", ["MMM D, YYYY"])).toBe("2025-03-03");
    expect(parseDateText("Paid on Foo 5, 2026", ["MMM D, YYYY"])).toBeNull();
  });
});

describe("receipts in another currency", () => {
  it("the engine hands back the amount in its own currency for conversion", () => {
    expect(runProfile(SAAS, { subject: "Your receipt from Ejemplo SaaS #1", text: saasReceipt("20.00", "November 5, 2026"), receivedAt: RECEIVED })).toEqual({
      status: "foreign",
      foreign: { date: "2026-11-05", merchant: "Ejemplo SaaS", kind: "gasto", currency: "USD", value: 20 },
    });
  });

  it("without convert, the amount stays in the profile's own currency", () => {
    const review = parseProfile({ ...SAAS, foreignCurrency: "review" });
    expect(runProfile(review, { subject: "Your receipt from Ejemplo SaaS #1", text: saasReceipt("20.00", "November 5, 2026"), receivedAt: RECEIVED }).status).toBe("movement");
  });

  it("is tested against confirmed examples like any other format", () => {
    const samples = [
      { subject: "Your receipt from Ejemplo SaaS #1", body: saasReceipt("20.00", "November 5, 2026"), expected: { date: "2026-11-05", merchant: "Ejemplo SaaS", kind: "gasto", foreign: { currency: "USD", value: 20 } } },
      { subject: "$20.00 payment was unsuccessful", body: "Tu pago no se pudo procesar", expected: { skip: true } },
    ].map((s) => sampleSchema.parse(s));
    expect(testProfile(SAAS, samples).map((r) => r.pass)).toEqual([true, true]);
    const wrong = sampleSchema.parse({ ...samples[0], expected: { date: "2026-11-05", merchant: "Ejemplo SaaS", kind: "gasto", foreign: { currency: "USD", value: 25 } } });
    expect(testProfile(SAAS, [wrong])[0]).toMatchObject({ pass: false });
  });

  describe("sync", () => {
    let db: DatabaseSync;
    beforeEach(() => {
      db = openDb(":memory:");
      addSender(db, SAAS_SENDER, "Ejemplo SaaS");
      saveProfile(db, SAAS_SENDER, SAAS, 4);
    });
    const receipt = mail("r1", SAAS_SENDER, "Your receipt from Ejemplo SaaS #1", saasReceipt("20.00", "November 5, 2026"));

    it("registers the receipt in pesos with the day's rate and marks it as an estimate", async () => {
      const summary = await syncMail(db, new FakeSource([receipt]), { since: "2026-11-01", rates: rates(3200) });
      expect(summary).toMatchObject({ registered: 1, converted: 1 });
      expect(db.prepare("SELECT date, amount, merchant, bank, kind, detail FROM movements").get()).toMatchObject({
        date: "2026-11-05", amount: 64000, merchant: "Ejemplo SaaS", bank: "ejemplosaas", kind: "gasto", detail: expect.stringContaining("USD 20.00"),
      });
    });

    it("does not count a charge twice when the bank's own notice already reported it", async () => {
      addMovement(db, { sourceId: "bank1", date: "2026-11-05", amount: 68000, merchant: "EJEMPLO* SAAS", bank: "bbva", kind: "gasto" });
      const summary = await syncMail(db, new FakeSource([receipt]), { since: "2026-11-01", rates: rates(3200) });
      expect(summary).toMatchObject({ registered: 0, converted: 0, skipped: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM movements").get()).toEqual({ n: 1 });
    });

    it("still counts it when the existing charge is a different amount or merchant", async () => {
      addMovement(db, { sourceId: "b1", date: "2026-11-05", amount: 150000, merchant: "EJEMPLO* SAAS", bank: "bbva", kind: "gasto" });
      addMovement(db, { sourceId: "b2", date: "2026-11-05", amount: 64000, merchant: "Otra Tienda", bank: "bbva", kind: "gasto" });
      expect((await syncMail(db, new FakeSource([receipt]), { since: "2026-11-01", rates: rates(3200) })).registered).toBe(1);
    });

    it("sends it to review when there is no exchange rate, and retries next time", async () => {
      const first = await syncMail(db, new FakeSource([receipt]), { since: "2026-11-01", rates: rates(null) });
      expect(first.registered).toBe(0);
      expect(first.review).toHaveLength(1);
      const again = new FakeSource([receipt]);
      await syncMail(db, again, { since: "2026-11-01", rates: rates(3200) });
      expect(again.fetched).toEqual(["r1"]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM movements").get()).toEqual({ n: 1 });
    });

    it("a receipt already converted does not hide the next one for the same merchant", async () => {
      const next = mail("r2", SAAS_SENDER, "Your receipt from Ejemplo SaaS #2", saasReceipt("20.00", "November 6, 2026"));
      const summary = await syncMail(db, new FakeSource([receipt, next]), { since: "2026-11-01", rates: rates(3200) });
      expect(summary.registered).toBe(2);
      const again = await syncMail(db, new FakeSource([mail("r3", SAAS_SENDER, "Your receipt from Ejemplo SaaS #3", saasReceipt("20.00", "November 7, 2026"))]), { since: "2026-11-01", rates: rates(3200) });
      expect(again.registered).toBe(1);
    });

    it("stops asking for a rate after the first failure in a run", async () => {
      let calls = 0;
      const failing: RateProvider = async () => (calls++, null);
      const next = mail("r2", SAAS_SENDER, "Your receipt from Ejemplo SaaS #2", saasReceipt("20.00", "November 6, 2026"));
      const summary = await syncMail(db, new FakeSource([receipt, next]), { since: "2026-11-01", rates: failing });
      expect(calls).toBe(1);
      expect(summary.review).toHaveLength(2);
    });

    it("ignores the notices that are not receipts", async () => {
      const failed = mail("f1", SAAS_SENDER, "$20.00 payment was unsuccessful", "No pudimos cobrar");
      const summary = await syncMail(db, new FakeSource([failed]), { since: "2026-11-01", rates: rates(3200) });
      expect(summary).toMatchObject({ registered: 0, skipped: 1 });
    });
  });
});

describe("receipts that describe an existing charge", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb(":memory:");
    addSender(db, STORE_SENDER);
    saveProfile(db, STORE_SENDER, STORE, 3);
  });
  const receipt = (id: string, date: string, product: string, total: string) => mail(id, STORE_SENDER, "Tu recibo de Tienda", storeReceipt(date, product, total));
  const detailOf = (id: number): unknown => (db.prepare("SELECT detail FROM movements WHERE id = ?").get(id) as { detail: string | null }).detail;

  it("the engine reads the product, amount and date without creating a movement", () => {
    expect(runProfile(STORE, { subject: "Tu recibo de Tienda", text: storeReceipt("26/10/2026", "Tienda TV Película Ejemplo (renta)", "12.900,00"), receivedAt: RECEIVED })).toEqual({
      status: "detail",
      detail: { date: "2026-10-26", amount: 12900, description: "Tienda TV Película Ejemplo (renta)", matchMerchant: ["tiendaejemplo.com/bill"] },
    });
  });

  it("names the movement with the same amount and date, keeping its merchant and category", async () => {
    const { id } = addMovement(db, { sourceId: "b1", date: "2026-10-26", amount: 12900, merchant: "Tiendaejemplo.com/bill", bank: "bbva", kind: "gasto", category: "suscripcion" });
    const summary = await syncMail(db, new FakeSource([receipt("a1", "26/10/2026", "Película Ejemplo", "12.900,00")]), { since: "2026-10-01", today: "2026-10-27" });
    expect(summary).toMatchObject({ registered: 0, enriched: 1, detailsWaiting: 0 });
    expect(detailOf(id)).toBe("Película Ejemplo");
    expect(db.prepare("SELECT merchant, category FROM movements WHERE id = ?").get(id)).toEqual({ merchant: "Tiendaejemplo.com/bill", category: "suscripcion" });
  });

  it("matches when the bank booked it a day or two off, and never downloads the receipt again", async () => {
    const { id } = addMovement(db, { sourceId: "b1", date: "2026-10-27", amount: 24900, merchant: "TIENDAEJEMPLO.COM/BILL", bank: "bbva", kind: "gasto" });
    const messages = [receipt("a1", "26/10/2026", "Aplicación Ejemplo", "24.900,00")];
    await syncMail(db, new FakeSource(messages), { since: "2026-10-01", today: "2026-10-27" });
    expect(detailOf(id)).toBe("Aplicación Ejemplo");
    const again = new FakeSource(messages);
    await syncMail(db, again, { since: "2026-10-01", today: "2026-10-27" });
    expect(again.fetched).toEqual([]);
  });

  it("waits, without changing anything, when no movement matches yet, and applies it once the bank's notice is there", async () => {
    const messages = [receipt("a1", "26/10/2026", "Película Ejemplo", "12.900,00")];
    expect(await syncMail(db, new FakeSource(messages), { since: "2026-10-01", today: "2026-10-27" })).toMatchObject({ enriched: 0, detailsWaiting: 1 });
    const { id } = addMovement(db, { sourceId: "b1", date: "2026-10-26", amount: 12900, merchant: "Tiendaejemplo.com/bill", bank: "bbva", kind: "gasto" });
    expect(await syncMail(db, new FakeSource(messages), { since: "2026-10-01", today: "2026-10-27" })).toMatchObject({ enriched: 1, detailsWaiting: 0 });
    expect(detailOf(id)).toBe("Película Ejemplo");
  });

  it("never touches a movement of another merchant or another amount", async () => {
    const other = addMovement(db, { sourceId: "b1", date: "2026-10-26", amount: 12900, merchant: "Supermercado Ejemplo", bank: "bbva", kind: "gasto" });
    const amount = addMovement(db, { sourceId: "b2", date: "2026-10-26", amount: 13900, merchant: "Tiendaejemplo.com/bill", bank: "bbva", kind: "gasto" });
    const summary = await syncMail(db, new FakeSource([receipt("a1", "26/10/2026", "Película Ejemplo", "12.900,00")]), { since: "2026-10-01", today: "2026-10-27" });
    expect(summary).toMatchObject({ enriched: 0, detailsWaiting: 1 });
    expect(detailOf(other.id)).toBeNull();
    expect(detailOf(amount.id)).toBeNull();
  });

  it("prefers the closest date, and leaves a tie alone", async () => {
    const near = addMovement(db, { sourceId: "b1", date: "2026-10-26", amount: 9900, merchant: "Tiendaejemplo.com/bill", bank: "bbva", kind: "gasto" });
    const far = addMovement(db, { sourceId: "b2", date: "2026-10-28", amount: 9900, merchant: "Tiendaejemplo.com/bill", bank: "bbva", kind: "gasto" });
    await syncMail(db, new FakeSource([receipt("a1", "26/10/2026", "Suscripción A", "9.900,00")]), { since: "2026-10-01", today: "2026-10-27" });
    expect([detailOf(near.id), detailOf(far.id)]).toEqual(["Suscripción A", null]);

    const tieA = addMovement(db, { sourceId: "c1", date: "2026-10-09", amount: 5900, merchant: "Tiendaejemplo.com/bill", bank: "bbva", kind: "gasto" });
    const tieB = addMovement(db, { sourceId: "c2", date: "2026-10-11", amount: 5900, merchant: "Tiendaejemplo.com/bill", bank: "bbva", kind: "gasto" });
    const summary = await syncMail(db, new FakeSource([receipt("a2", "10/10/2026", "Suscripción B", "5.900,00")]), { since: "2026-10-01", today: "2026-10-27" });
    expect(summary).toMatchObject({ enriched: 0, detailsWaiting: 1 });
    expect([detailOf(tieA.id), detailOf(tieB.id)]).toEqual([null, null]);
  });

  it("gives up on a receipt that finds no movement after a month, so it is not downloaded forever", async () => {
    const messages = [receipt("a1", "01/10/2026", "Aplicación Antigua", "7.900,00")];
    expect(await syncMail(db, new FakeSource(messages), { since: "2026-10-01", today: "2026-10-20" })).toMatchObject({ detailsWaiting: 1 });
    const late = await syncMail(db, new FakeSource(messages), { since: "2026-10-01", today: "2026-12-01" });
    expect(late).toMatchObject({ detailsWaiting: 0, enriched: 0 });
    const after = new FakeSource(messages);
    await syncMail(db, after, { since: "2026-10-01", today: "2026-12-02" });
    expect(after.fetched).toEqual([]);
  });

  it("the report shows what each movement was for", () => {
    addMovement(db, { sourceId: "b1", date: "2026-10-26", amount: 12900, merchant: "Tiendaejemplo.com/bill", bank: "bbva", kind: "gasto", detail: "Película Ejemplo" });
    const data = dashboardData(db, "2026-10", { today: "2026-11-13" });
    expect(data.movements[0]).toMatchObject({ merchant: "Tiendaejemplo.com/bill", detail: "Película Ejemplo" });
  });
});
