import { textOf } from "../../provider/api.js";
import {
  ORDER_ID_RE,
  parseOrderTiles,
  queryOf,
  returnWindow,
  tileImage,
  TRACK_LINK_RE,
  type OrderTile,
} from "./pages.js";
import { unescapeHtml } from "./text.js";

/**
 * Reads the orders page as "order cards": one block per order with a header (order placed,
 * total, dispatch to, order number) and one delivery box per shipment (its status lines, its
 * items, its return window and its "Track package" link). The account's language may be English
 * or German; labels are matched in both, case-insensitively (the page shows them in capitals by
 * style only).
 */

/** What an order card's header says about the whole order. */
export interface OrderHeader {
  readonly orderId: string;
  /** "18 November 2026", "18. November 2026" or "November 18, 2026", as shown. */
  readonly placedText: string | null;
  /** "€23.45", "23,45 €", as shown. */
  readonly totalText: string | null;
}

const CARD_RE = /<div\b[^>]*\bclass="[^"]*\border-card\b[^"]*"/g;
const BOX_RE = /<div\b[^>]*\bclass="[^"]*\bdelivery-box\b[^"]*"/g;
const ITEM_RE = /<div\b[^>]*\bclass="[^"]*\byohtmlc-item\b[^"]*"/g;
const PRIMARY_RE = /\byohtmlc-shipment-status-primaryText\b[^>]*>(.*?)<\/div>/s;
const SECONDARY_RE = /\byohtmlc-shipment-status-secondaryText\b[^>]*>(.*?)<\/div>/s;
const TITLE_RE = /\byohtmlc-product-title\b[^>]*>(.*?)<\/div>/s;
const PRODUCT_LINK_RE = /<a\b[^>]*href="[^"]*\/(?:dp|gp\/product)\/[^"]*"[^>]*>(.*?)<\/a>/gs;
const DETAILS_LINK_RE = /href="([^"]*\/order-details\?[^"]*)"/;
const PLACED_LABEL_RE = /^(?:order placed|bestellung aufgegeben|bestellt am|bestelldatum)$/i;
const TOTAL_LABEL_RE = /^(?:total|order total|summe|gesamt|gesamtbetrag|gesamtsumme)$/i;

/** Splits `html` at every match of `re`; the part before the first match is returned apart. */
function splitAt(html: string, re: RegExp): { head: string; parts: string[] } {
  const starts = [...html.matchAll(re)].map((match) => match.index);
  if (starts.length === 0) return { head: html, parts: [] };
  return {
    head: html.slice(0, starts[0]),
    parts: starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length)),
  };
}

/** The text pieces of a fragment, one per run of text between tags. */
function pieces(fragment: string): string[] {
  return fragment
    .split(/<[^>]*>/)
    .map((piece) => textOf(piece))
    .filter((piece) => piece !== "");
}

/** The piece after the first one `label` matches. */
function valueAfter(list: readonly string[], label: RegExp): string | null {
  const index = list.findIndex((piece) => label.test(piece));
  return index === -1 ? null : (list[index + 1] ?? null);
}

function header(card: string, head: string): OrderHeader | null {
  const list = pieces(head);
  const orderId =
    ORDER_ID_RE.exec(list.join(" "))?.[0] ??
    ORDER_ID_RE.exec(queryOf(DETAILS_LINK_RE.exec(card)?.[1] ?? "").get("orderid") ?? "")?.[0];
  if (orderId === undefined) return null;
  return {
    orderId,
    placedText: valueAfter(list, PLACED_LABEL_RE),
    totalText: valueAfter(list, TOTAL_LABEL_RE),
  };
}

function itemTitle(item: string): string {
  const block = TITLE_RE.exec(item)?.[1];
  if (block !== undefined && textOf(block) !== "") return textOf(block);
  for (const match of item.matchAll(PRODUCT_LINK_RE)) {
    const title = textOf(match[1] ?? "");
    if (title !== "") return title;
  }
  return "";
}

interface BoxContext {
  readonly order: OrderHeader;
  readonly detailsPath: string;
  readonly boxIndex: number;
  readonly isStatus: (text: string) => boolean;
}

/** The order lines of one delivery box: one per item, sharing the box's status and link. */
function boxTiles(box: string, context: BoxContext, position: number): OrderTile[] {
  const primary = PRIMARY_RE.exec(box)?.[1];
  const statusText =
    primary === undefined
      ? (pieces(box).find((piece) => context.isStatus(piece)) ?? "")
      : textOf(primary);
  const secondary = SECONDARY_RE.exec(box)?.[1];
  const note = secondary === undefined || textOf(secondary) === "" ? null : textOf(secondary);
  const trackLink = TRACK_LINK_RE.exec(box)?.[1];
  const trackPath = trackLink === undefined ? null : unescapeHtml(trackLink);
  const query = queryOf(trackPath ?? "");
  // A box not yet shipped has no shipment id: it is keyed by its place in the order.
  const shipmentId =
    query.get("shipmentid") ?? `${context.order.orderId}-box${String(context.boxIndex + 1)}`;
  const { head, parts } = splitAt(box, ITEM_RE);
  const items = parts.length === 0 ? [head] : parts;
  const boxReturn = returnWindow(box);
  return items.map((item, index) => ({
    orderId: context.order.orderId,
    lineItemId: "",
    shipmentId,
    packageId: "1",
    path: trackPath ?? context.detailsPath,
    title: itemTitle(item),
    statusText,
    note,
    placedText: context.order.placedText,
    position: position + index,
    imageUrl: tileImage(item),
    returnWindowText: returnWindow(item) ?? boxReturn,
  }));
}

/** Every order card's header and order lines, in page order; empty without order cards. */
export function parseOrderCards(
  page: string,
  isStatus: (text: string) => boolean,
): { tiles: OrderTile[]; orders: OrderHeader[] } {
  const tiles: OrderTile[] = [];
  const orders: OrderHeader[] = [];
  for (const card of splitAt(page, CARD_RE).parts) {
    const { head, parts } = splitAt(card, BOX_RE);
    const order = header(card, head);
    if (order === null) continue;
    orders.push(order);
    const detailsLink = DETAILS_LINK_RE.exec(card)?.[1];
    const detailsPath =
      detailsLink === undefined
        ? `/gp/your-account/order-details?orderID=${order.orderId}`
        : unescapeHtml(detailsLink);
    for (const [boxIndex, box] of parts.entries()) {
      tiles.push(...boxTiles(box, { order, detailsPath, boxIndex, isStatus }, tiles.length));
    }
  }
  return { tiles, orders };
}

/** The orders on one orders page: their headers and their order lines. */
export interface OrderList {
  readonly tiles: OrderTile[];
  readonly orders: OrderHeader[];
}

/**
 * Reads an orders page in either layout Amazon serves: order cards (the desktop page), or the
 * compact item lines whose link label names title, placed date and status (the mobile page).
 * The compact lines carry no total, so their headers name none.
 */
export function parseOrderList(page: string, isStatus: (text: string) => boolean): OrderList {
  const cards = parseOrderCards(page, isStatus);
  if (cards.orders.length > 0) return cards;
  const tiles = parseOrderTiles(page, isStatus);
  const orders = new Map<string, OrderHeader>();
  for (const tile of tiles) {
    if (!orders.has(tile.orderId)) {
      orders.set(tile.orderId, {
        orderId: tile.orderId,
        placedText: tile.placedText,
        totalText: null,
      });
    }
  }
  return { tiles, orders: [...orders.values()] };
}
