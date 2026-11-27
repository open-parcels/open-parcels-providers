/**
 * Made-up Amazon pages. Only the structure mirrors the storefront; every id, title, place and
 * coordinate is invented.
 */

export interface TileSpec {
  readonly orderId: string;
  readonly shipmentId?: string;
  readonly lineItemId?: string;
  readonly title: string;
  readonly status: string;
  /** Links straight to the package page instead of the order line. */
  readonly direct?: boolean;
  /** Raw attributes of the line's product-image `<img>`, e.g. `src="…"`. */
  readonly image?: string;
  /** Text shown under the line, such as its return window. */
  readonly note?: string;
  /** The placed date as the line names it; "10 November 2026" when not given. */
  readonly placed?: string;
}

/** The parts of an orders page around its lines: the time filter's years and paging links. */
export interface ListingSpec {
  readonly years?: readonly number[];
  /** The year the page lists, carried by its paging links; none for the default listing. */
  readonly year?: number;
  /** 0-based `page` of the next page's link, when there is a next page. */
  readonly next?: number;
  /** 0-based `page` of the previous page's link. */
  readonly previous?: number;
}

/** A paging link as the desktop page writes it: under a language prefix, `page` 0-based. */
export function pagingHref(year: number | undefined, page: number): string {
  const filter = year === undefined ? "" : `timeFilter=year-${String(year)}&amp;`;
  return `/-/en/your-orders/orders?${filter}page=${String(page)}&amp;ref_=ppx_yo2ov_dt_b_pagination`;
}

const attr = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function tilePath(tile: TileSpec): string {
  const query = new URLSearchParams({ orderId: tile.orderId });
  if (tile.shipmentId !== undefined) {
    query.set("shipmentId", tile.shipmentId);
  }
  if (tile.lineItemId !== undefined) {
    query.set("lineItemId", tile.lineItemId);
  }
  const path =
    tile.direct === true ? "/progress-tracker/package" : "/gp/your-account/order-details";
  return `${path}?${query.toString()}`;
}

export function ordersPage(tiles: readonly TileSpec[], listing: ListingSpec = {}): string {
  const cards = tiles
    .map(
      (tile) =>
        `<div class="item-card"><a class="item-card__link" href="${attr(tilePath(tile))}" ` +
        `aria-label="${attr(`${tile.title}, Order placed ${tile.placed ?? "10 November 2026"}, ${tile.status}`)}">` +
        `<img src="https://img.example.invalid/1.jpg"></a>` +
        (tile.image === undefined
          ? ""
          : `<div class="product-image a-spacing-none"><img alt="" ${tile.image}></div>`) +
        (tile.note === undefined ? "" : `<span class="a-color-secondary">${tile.note}</span>`) +
        `</div>`,
    )
    .join("\n");
  // The nav bar's search box comes first, a select of its own; it lists no years.
  const search =
    `<select id="searchDropdownBox" name="url"><option value="search-alias=aps">All</option>` +
    `<option value="search-alias=year-2001">Made-up department</option></select>`;
  const filter =
    listing.years === undefined
      ? ""
      : `<form class="js-time-filter-form" method="get" action="/your-orders/orders">` +
        `<input type="hidden" name="ref_" value="ppx_yo2ov_dt_b_filter_all">` +
        `<select name="timeFilter" autocomplete="off" id="time-filter" class="a-native-dropdown">` +
        `<option value="last30">past 30 days</option>` +
        `<option value="months-3" selected>past three months</option>` +
        listing.years
          .map((year) => `<option value="year-${String(year)}">${String(year)}</option>`)
          .join("") +
        `</select></form>`;
  const previous =
    listing.previous === undefined
      ? ""
      : `<li class="a-normal"><a href="${pagingHref(listing.year, listing.previous)}">Previous</a></li>`;
  const next =
    listing.next === undefined
      ? `<li class="a-disabled a-last">Next</li>`
      : `<li class="a-last"><a href="${pagingHref(listing.year, listing.next)}">Next</a></li>`;
  const paging = `<ul class="a-pagination">${previous}${next}</ul>`;
  return `<html><body>${search}<h1>Your Orders</h1>${filter}${cards}${paging}</body></html>`;
}

export function trackPath(orderId: string, shipmentId: string): string {
  return `/progress-tracker/package?orderId=${orderId}&shipmentId=${shipmentId}&packageIndex=0`;
}

export function linePage(orderId: string, shipmentId: string): string {
  return `<html><body><a href="${attr(trackPath(orderId, shipmentId))}">Track package</a></body></html>`;
}

export interface TrackSpec {
  readonly trackingId: string;
  readonly shortStatus: string;
  readonly milestone?: string;
  readonly carrierLine?: string;
  readonly promiseMessage?: string;
  readonly windowEndsInMs?: number;
  readonly callout?: string;
  readonly events?: readonly { date: string; time: string; message: string; location?: string }[];
}

/** A package page: page-state JSON plus the carrier block and the server-rendered timeline. */
export function trackPage(spec: TrackSpec): string {
  const state = {
    shortStatus: spec.shortStatus,
    orderId: "000-0000000-0000000",
    trackingId: spec.trackingId,
    timezone: "Europe/Berlin",
    locale: "de-DE",
    customerId: "AEXAMPLECUSTOMER",
    hereMapsApiKey: "made-up-map-key",
    promise: { promiseMessage: spec.promiseMessage ?? "" },
    ...(spec.windowEndsInMs === undefined
      ? {}
      : { timeUntilPredictedDeliveryWindowEnd: spec.windowEndsInMs }),
    progressTracker: {
      lastReachedMilestone: spec.milestone ?? spec.shortStatus,
      numberOfReachedMilestones: 2,
    },
    ...(spec.callout === undefined
      ? {}
      : {
          mapTracking: {
            calloutMessage: spec.callout,
            destinationLatitude: 11.111,
            destinationLongitude: 22.222,
            url: "/progress-tracker/package/actions/map-tracking",
          },
        }),
  };
  const events = (spec.events ?? [])
    .map(
      (event) =>
        `<div class="tracking-event-date-header"><span class="tracking-event-date">${event.date}</span></div>` +
        `<div class="tracking-event-row"><span class="tracking-event-time">${event.time}</span>` +
        `<span class="tracking-event-message">${event.message}</span>` +
        `<span class="tracking-event-location">${event.location ?? ""}</span></div>`,
    )
    .join("");
  return (
    `<html><head><script type="a-state" data-a-state='{"key":"page-state"}'>` +
    `${JSON.stringify(state)}</script></head><body>` +
    `<input type="hidden" name="csrfToken" value="made-up-csrf-token">` +
    `<div id="carrierRelatedInfo-container"><span>${spec.carrierLine ?? "Delivery by Amazon"}</span>` +
    `<span>Tracking ID: ${spec.trackingId}</span></div>` +
    `<div id="tracking-events-container">${events}</div></body></html>`
  );
}

export const SIGN_IN_PAGE =
  '<html><body><form action="/ap/signin"><input type="email"><input type="password"></form></body></html>';

export const CAPTCHA_PAGE =
  '<html><body><form action="/errors/validateCaptcha"><input id="captchacharacters"></form></body></html>';

export function cookieExchange(domain: string): unknown {
  return {
    response: {
      tokens: {
        cookies: {
          [`.${domain}`]: [
            { Name: "session-id", Value: "000-0000000-0000000", Path: "/" },
            { Name: "at-acbde", Value: '"made-up-cookie"', Path: "/" },
          ],
        },
      },
    },
  };
}
