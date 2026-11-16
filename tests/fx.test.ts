import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.js";
import { trmRateProvider } from "../src/domain/fx.js";

function fakeFetch(body: unknown, ok = true): { fn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return { ok, json: async () => body } as Response;
  }) as typeof fetch;
  return { fn, urls };
}

describe("trmRateProvider", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("reads the official rate for the day and caches it", async () => {
    const http = fakeFetch([{ valor: "3221.19", unidad: "COP", vigenciadesde: "2026-11-05T00:00:00.000" }]);
    const rate = trmRateProvider(db, http.fn);
    expect(await rate("USD", "2026-11-05")).toBe(3221.19);
    expect(await rate("USD", "2026-11-05")).toBe(3221.19);
    expect(http.urls).toHaveLength(1);
    expect(http.urls[0]).toContain("2026-11-05");
  });

  it("only knows USD and real dates, without calling the network otherwise", async () => {
    const http = fakeFetch([{ valor: "4000" }]);
    const rate = trmRateProvider(db, http.fn);
    expect(await rate("EUR", "2026-11-05")).toBeNull();
    expect(await rate("USD", "05/11/2026")).toBeNull();
    expect(await rate("USD", "2026-11-05' OR 1=1")).toBeNull();
    expect(http.urls).toHaveLength(0);
  });

  it("returns null on server errors, malformed answers, implausible values and network failures", async () => {
    expect(await trmRateProvider(db, fakeFetch([], false).fn)("USD", "2026-11-05")).toBeNull();
    expect(await trmRateProvider(db, fakeFetch({ nope: 1 }).fn)("USD", "2026-11-05")).toBeNull();
    expect(await trmRateProvider(db, fakeFetch([{ valor: "12" }]).fn)("USD", "2026-11-05")).toBeNull();
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await trmRateProvider(db, boom)("USD", "2026-11-05")).toBeNull();
  });
});
