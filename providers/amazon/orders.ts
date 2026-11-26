import { ignoredStatus, mapStatus, type OrderSnapshot, type Rules } from "../../provider/api.js";
import { AMAZON_ID, isSkipped } from "./build.js";
import { localIso, placedDay } from "./dates.js";
import type { OrderList } from "./order-cards.js";
import type { OrderTile } from "./pages.js";
import type { Storefront } from "./storefronts.js";

/**
 * Order reports from the orders page: placed date, total, items and where the order stands, as
 * its order lines say. Both the polling run and "Import history" report them, so an order the
 * page lists as delivered or cancelled is stored that way even without a parcel to carry it.
 */

/** Currency marks as the order pages print them; longer marks before the `$` they contain. */
const CURRENCIES: readonly (readonly [RegExp, string])[] = [
  [/€|\bEUR\b/, "EUR"],
  [/£|\bGBP\b/, "GBP"],
  [/CDN\$|CA\$|\bCAD\b/, "CAD"],
  [/A\$|AU\$|\bAUD\b/, "AUD"],
  [/₹|\bINR\b|\bRs\.?/, "INR"],
  [/\$|\bUSD\b/, "USD"],
];

/**
 * "€23.45", "23,45 €", "EUR 1.234,56", "$1,234.56": the amount and its currency. A separator
 * followed by exactly two digits at the end is the decimal one; every other separator groups
 * thousands. Null for anything else.
 */
export function parseTotal(text: string | null): { amount: number; currency: string } | null {
  if (text === null) return null;
  const currency = CURRENCIES.find(([mark]) => mark.test(text))?.[1];
  const number = /\d[\d.,\s]*/.exec(text)?.[0].replace(/\s+/g, "");
  if (currency === undefined || number === undefined) return null;
  const decimal = /[.,](\d{2})$/.exec(number);
  const whole = (decimal === null ? number : number.slice(0, decimal.index)).replace(/[.,]/g, "");
  const amount = Number(`${whole}.${decimal?.[1] ?? "00"}`);
  return whole === "" || !Number.isFinite(amount) ? null : { amount, currency };
}

/**
 * Where the order stands as its lines say: delivered when every line still a parcel says so,
 * shipped when one is on its way, cancelled when every line is, unknown otherwise.
 */
function orderStatus(rules: Rules, tiles: readonly OrderTile[]): OrderSnapshot["status"] {
  const parcels = tiles.filter((tile) => !isSkipped(rules, tile.statusText));
  if (parcels.length === 0) {
    const cancelled = tiles.some(
      (tile) => ignoredStatus(rules, AMAZON_ID, { text: tile.statusText }) === "order_cancelled",
    );
    return cancelled ? "cancelled" : null;
  }
  const statuses = parcels.map(
    (tile) => mapStatus(rules, AMAZON_ID, { text: tile.statusText })?.status ?? null,
  );
  if (statuses.every((status) => status === "delivered")) return "delivered";
  return statuses.some((status) => status !== null && status !== "registered") ? "shipped" : null;
}

/** One order report per order on the page. */
export function orderReports(
  rules: Rules,
  storefront: Storefront,
  list: OrderList,
): OrderSnapshot[] {
  return list.orders.map((order) => {
    const lines = list.tiles.filter((tile) => tile.orderId === order.orderId);
    const day = placedDay(order.placedText);
    return {
      order: { shop: AMAZON_ID, orderNumber: order.orderId },
      status: orderStatus(rules, lines),
      at: day === null ? null : localIso(day, 0, 0, storefront.timeZone),
      items: lines.map((line) => line.title).filter((title) => title !== ""),
      total: parseTotal(order.totalText),
      payment: false,
    };
  });
}
