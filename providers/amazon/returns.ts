import {
  ignoredStatus,
  parseArrival,
  returnSnapshot,
  type ReturnSnapshot,
  type ReturnStatus,
  type Rules,
} from "../../provider/api.js";
import { AMAZON_ID } from "./build.js";
import { pastDay, type Day } from "./dates.js";
import type { OrderTile } from "./pages.js";
import type { Storefront } from "./storefronts.js";

/** Where an order line that is no parcel stands as a return, by the status table's ignore list. */
const RETURN_EVENTS: Readonly<Record<string, ReturnStatus>> = {
  return_started: "requested",
  return_received: "received",
  refund_issued: "refunded",
  return_rejected: "rejected",
};

/** "Return window closed on …": a day in the past; "Eligible through …": one ahead. */
const CLOSED_RE = /\b(?:closed|endete|geschlossen|abgelaufen|expired)\b/i;

function isoDay(day: Day): string {
  return `${String(day.year)}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

/** The last day of an order line's return window, `YYYY-MM-DD`, when the line names one. */
export function returnUntil(
  rules: Rules,
  tile: OrderTile,
  now: Date,
  storefront: Storefront,
): string | null {
  const text = tile.returnWindowText;
  if (text === null) return null;
  if (CLOSED_RE.test(text)) {
    const day = pastDay(rules, text, now, storefront.timeZone);
    return day === null ? null : isoDay(day);
  }
  // The window's start carries the storefront's offset, so its date part is the local day.
  return (
    parseArrival(rules, text, { now, timeZone: storefront.timeZone })?.from.slice(0, 10) ?? null
  );
}

/**
 * Returns the orders page shows: lines whose status is a return or refund step ("Return
 * started", "Refund issued"). One report per order, naming its lines; a refund alone may be for a
 * cancelled line, so it only updates a return already known.
 */
export function tileReturns(rules: Rules, tiles: readonly OrderTile[]): ReturnSnapshot[] {
  const byOrder = new Map<string, { status: ReturnStatus; event: string; titles: string[] }>();
  for (const tile of tiles) {
    const event = ignoredStatus(rules, AMAZON_ID, { text: tile.statusText });
    const status = event === null ? undefined : RETURN_EVENTS[event];
    if (event === null || status === undefined) continue;
    const known = byOrder.get(tile.orderId);
    if (known === undefined) {
      byOrder.set(tile.orderId, { status, event, titles: [tile.title] });
    } else {
      known.titles.push(tile.title);
    }
  }
  return [...byOrder].map(([orderNumber, found]) =>
    returnSnapshot({
      order: { shop: AMAZON_ID, orderNumber },
      status: found.status,
      items: found.titles,
      mayCreate: found.event !== "refund_issued",
    }),
  );
}
