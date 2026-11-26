import { readFileSync } from "node:fs";
import path from "node:path";
import { loadRules } from "open-parcels-rules";
import { describe, expect, it } from "vitest";
import { readAccount, type AmazonContext } from "../../../src/carriers/amazon/account.js";
import { readsAsStatus } from "../../../src/carriers/amazon/build.js";
import { amazonCarrier } from "../../../src/carriers/amazon/index.js";
import { parseOrderList } from "../../../src/carriers/amazon/order-cards.js";
import { parseTotal } from "../../../src/carriers/amazon/orders.js";
import { FakeClock } from "../../helpers.js";
import { fakeContext, fakeNetwork, html, json } from "../harness.js";
import { cookieExchange, trackPage } from "./amazon-fixtures.js";

/** The made-up orders pages in `fixtures/orders/`, laid out under the server's test fixtures. */
const FIXTURES = path.join(import.meta.dirname, "..", "..", "fixtures", "orders", "amazon");
const EN = readFileSync(path.join(FIXTURES, "orders-en.html"), "utf8");
const DE = readFileSync(path.join(FIXTURES, "orders-de.html"), "utf8");

const rules = loadRules();
const plugin = amazonCarrier(rules);
const isStatus = (text: string): boolean => readsAsStatus(rules, text);
/** Built from parts, so no literal credential sits in the file. */
const REFRESH = ["Atnr", "made", "up"].join("|");

/** An orders page without order cards: the listing has ended. */
const EMPTY_PAGE = "<html><body><h1>Your Orders</h1></body></html>";

function account(first: string): { context: AmazonContext; calls: () => string[] } {
  const network = fakeNetwork([
    ({ url }) => {
      if (url.pathname === "/ap/exchangetoken/cookies") return json(cookieExchange("amazon.de"));
      if (url.pathname === "/your-orders/orders") {
        return html(url.searchParams.has("startIndex") ? EMPTY_PAGE : first);
      }
      if (url.pathname === "/gp/your-account/ship-track") {
        const shipment = url.searchParams.get("shipmentId") ?? "";
        return html(
          trackPage({
            trackingId: `TBA00000000${shipment.slice(-1)}`,
            shortStatus: shipment.endsWith("2") ? "IN_TRANSIT" : "DELIVERED",
          }),
        );
      }
      return html("", 404);
    },
  ]);
  const fake = fakeContext(plugin, network.fetchImpl, {
    clock: new FakeClock("2026-11-26T10:00:00.000Z"),
  });
  return {
    context: {
      ...fake.base,
      config: { storefront: "amazon.de" },
      secret: { refreshToken: REFRESH, deviceSerial: "0123456789ABCDEF0123456789ABCDEF" },
    },
    calls: () => network.calls.map((call) => `${call.url.pathname}${call.url.search}`),
  };
}

describe("Amazon order cards", () => {
  it("reads each card's header and its delivery boxes in English", () => {
    const list = parseOrderList(EN, isStatus);
    expect(list.orders).toEqual([
      { orderId: "900-0000000-0000101", placedText: "10 November 2026", totalText: "€23.45" },
      { orderId: "900-0000000-0000102", placedText: "20 November 2026", totalText: "€1,234.56" },
      { orderId: "900-0000000-0000103", placedText: "2 October 2026", totalText: "€9.99" },
      { orderId: "900-0000000-0000104", placedText: "21 November 2026", totalText: "€5.00" },
    ]);
    expect(list.tiles.map((tile) => [tile.orderId, tile.title, tile.statusText])).toEqual([
      ["900-0000000-0000101", "Made-up desk lamp, white", "Delivered 18 November"],
      ["900-0000000-0000102", "Made-up office chair", "Arriving by 18 December"],
      ["900-0000000-0000102", "Made-up seat cushion", "Arriving by 18 December"],
      ["900-0000000-0000103", "Made-up phone case", "Delivered 5 October"],
      ["900-0000000-0000104", "Made-up cable", "Cancelled"],
    ]);
    const [lamp, chair, cushion, phoneCase] = list.tiles;
    expect(lamp).toMatchObject({
      shipmentId: "MadeUpShip1",
      note: "Parcel was left in letterbox",
      imageUrl: "https://m.media-amazon.com/images/I/made-up-lamp._SS142_.jpg",
    });
    expect(lamp?.returnWindowText).toMatch(/^Eligible through 18 December 2026/);
    expect(lamp?.path).toMatch(/^\/gp\/your-account\/ship-track\?itemId=madeupitem1&/);
    // Two items in one box are one shipment.
    expect(cushion?.shipmentId).toBe(chair?.shipmentId);
    expect(phoneCase?.returnWindowText).toMatch(/^Return window closed on 4 November/);
    expect(phoneCase).toMatchObject({
      shipmentId: "900-0000000-0000103-box1",
      path: "/gp/your-account/order-details?orderID=900-0000000-0000103",
    });
  });

  it("reads the same structure in German", () => {
    const list = parseOrderList(DE, isStatus);
    expect(list.orders.map((order) => [order.placedText, order.totalText])).toEqual([
      ["12. November 2026", "23,45 €"],
      ["22. November 2026", "1.234,56 €"],
      ["1. Oktober 2026", "9,99 €"],
      ["23. November 2026", "5,00 €"],
    ]);
    expect(list.tiles.map((tile) => tile.statusText)).toEqual([
      "Zugestellt: 18. November",
      "Zustellung bis 18. Dezember",
      "Zugestellt: 3. Oktober",
      "Storniert",
    ]);
    expect(list.tiles[0]?.note).toBe("Paket wurde im Briefkasten hinterlegt");
    expect(list.tiles[0]?.returnWindowText).toMatch(/^Möglich bis 18. Dezember 2026/);
    expect(list.tiles[2]?.returnWindowText).toMatch(/^Rückgabezeitraum endete am 2. November/);
  });

  it("reads totals in either notation", () => {
    expect(parseTotal("€23.45")).toEqual({ amount: 23.45, currency: "EUR" });
    expect(parseTotal("1.234,56 €")).toEqual({ amount: 1234.56, currency: "EUR" });
    expect(parseTotal("€1,234.56")).toEqual({ amount: 1234.56, currency: "EUR" });
    expect(parseTotal("£7")).toEqual({ amount: 7, currency: "GBP" });
    expect(parseTotal("CDN$ 12.00")).toEqual({ amount: 12, currency: "CAD" });
    expect(parseTotal("$1,234")).toEqual({ amount: 1234, currency: "USD" });
    expect(parseTotal("free")).toBeNull();
    expect(parseTotal(null)).toBeNull();
  });
});

describe("Amazon polling run over order cards", () => {
  it("reports every order with date, total and status, and parcels with return windows", async () => {
    const { context, calls } = account(EN);
    const result = await readAccount(context, rules);
    expect(
      result.orders?.map((order) => [order.order.orderNumber, order.status, order.at]),
    ).toEqual([
      ["900-0000000-0000101", "delivered", "2026-11-09T23:00:00.000Z"],
      ["900-0000000-0000102", "shipped", "2026-11-19T23:00:00.000Z"],
      ["900-0000000-0000103", "delivered", "2026-10-01T22:00:00.000Z"],
      ["900-0000000-0000104", "cancelled", "2026-11-20T23:00:00.000Z"],
    ]);
    expect(result.orders?.[1]).toMatchObject({
      total: { amount: 1234.56, currency: "EUR" },
      items: ["Made-up office chair", "Made-up seat cushion"],
    });
    const byOrder = new Map(result.snapshots.map((s) => [s.order?.orderNumber, s]));
    expect(byOrder.get("900-0000000-0000101")).toMatchObject({
      delivered: true,
      order: { placedAt: "2026-11-09T23:00:00.000Z", returnUntil: "2026-12-18" },
    });
    expect(byOrder.get("900-0000000-0000102")).toMatchObject({
      delivered: false,
      trackingNumber: "TBA000000002",
      items: [{ title: "Made-up office chair" }, { title: "Made-up seat cushion" }],
    });
    expect(byOrder.get("900-0000000-0000103")?.order?.returnUntil).toBe("2026-11-04");
    expect(byOrder.has("900-0000000-0000104")).toBe(false);
    // The second page is read; nothing behind it is.
    expect(calls().filter((call) => call.startsWith("/your-orders/orders"))).toEqual([
      "/your-orders/orders",
      "/your-orders/orders?startIndex=10",
    ]);
    expect(result.complete).toBe(true);
  });

  it("reads German pages the same way", async () => {
    const { context } = account(DE);
    const result = await readAccount(context, rules);
    expect(result.orders?.map((order) => [order.status, order.total?.amount])).toEqual([
      ["delivered", 23.45],
      ["shipped", 1234.56],
      ["delivered", 9.99],
      ["cancelled", 5],
    ]);
    const returns = result.snapshots.map((s) => [s.order?.orderNumber, s.order?.returnUntil]);
    expect(returns).toEqual(
      expect.arrayContaining([
        ["900-0000000-0000201", "2026-12-18"],
        ["900-0000000-0000203", "2026-11-02"],
      ]),
    );
  });
});
