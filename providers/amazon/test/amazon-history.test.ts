import { loadRules } from "open-parcels-rules";
import { describe, expect, it } from "vitest";
import type { AmazonConfig } from "../../../src/carriers/amazon/account.js";
import type { AmazonSecret } from "../../../src/carriers/amazon/auth.js";
import { amazonCarrier } from "../../../src/carriers/amazon/index.js";
import { linkUrl } from "../../../src/provider/manifest.js";
import { builtinManifest } from "../../manifests.js";
import {
  CaptchaError,
  PageChangedError,
  SignInRejectedError,
  type ActionBatch,
  type ActionContext,
  type ActionResult,
  type JobProgress,
} from "../../../src/provider/api.js";
import { fakeContext, fakeNetwork, html, json } from "../harness.js";
import {
  CAPTCHA_PAGE,
  cookieExchange,
  ordersPage,
  pagingHref,
  SIGN_IN_PAGE,
  trackPage,
  type ListingSpec,
  type TileSpec,
} from "./amazon-fixtures.js";

/**
 * The "Import history" action over made-up order pages: every id, title and date is invented.
 * The fake clock stands at 18 November 2026.
 */

const rules = loadRules();
const plugin = amazonCarrier(rules);
const action = plugin.actions?.["import_history"];
const REFRESH = ["Atnr", "made", "up"].join("|");
const SERIAL = "0123456789ABCDEF0123456789ABCDEF";

/** One year's pages of order lines, by 0-based `page`. */
type Years = Readonly<Record<number, readonly (readonly TileSpec[])[]>>;

interface Run {
  readonly result: Promise<ActionResult>;
  /** "path?query" of every orders, line and package page read. */
  readonly pages: string[];
  readonly batches: ActionBatch[];
  readonly waits: number[];
  readonly progress: JobProgress[];
  readonly checkpoints: unknown[];
  readonly reports: string[];
}

interface Options {
  readonly years?: Years;
  /** The years the default page's time filter lists; empty: the page has no time filter. */
  readonly listed?: readonly number[];
  readonly checkpoint?: unknown;
  readonly input?: unknown;
  /** Answers a page instead of the storefront; undefined falls through to it. */
  readonly override?: (request: {
    readonly url: URL;
    readonly count: number;
  }) => Response | undefined;
  /** Called at every wait; may abort the job. */
  readonly onWait?: (count: number, abort: () => void) => void;
}

const YEARS_LISTED = [2026, 2024];

const RECENT: TileSpec = {
  orderId: "000-2222222-0000001",
  shipmentId: "SHIPNEW1",
  title: "Example mug",
  status: "Versandt",
  placed: "12 November 2026",
  direct: true,
};
const DELIVERED_IN_MARCH: TileSpec = {
  orderId: "000-2222222-0000002",
  shipmentId: "SHIPOLD1",
  title: "Example scarf",
  status: "Zugestellt 3. März",
  placed: "1 March 2026",
};
const CANCELLED: TileSpec = {
  orderId: "000-2222222-0000003",
  title: "Example board game",
  status: "Storniert",
  placed: "2 February 2026",
};
const IN_2024: TileSpec = {
  orderId: "000-2222222-0000004",
  shipmentId: "SHIPOLD2",
  title: "Example umbrella",
  status: "Zugestellt 9. Mai",
  placed: "5 May 2024",
};

const DEFAULT_YEARS: Years = {
  2026: [[RECENT, DELIVERED_IN_MARCH], [CANCELLED]],
  2024: [[IN_2024]],
};

function listing(years: Years, year: number, index: number): string | undefined {
  const pages = years[year] ?? [];
  // A year the filter lists may have no order lines at all.
  const tiles = pages.length === 0 && index === 0 ? [] : pages[index];
  if (tiles === undefined) return undefined;
  const spec: ListingSpec = {
    year,
    ...(index + 1 < pages.length ? { next: index + 1 } : {}),
    ...(index > 0 ? { previous: index - 1 } : {}),
  };
  return ordersPage(tiles, spec);
}

function run(options: Options = {}): Run {
  if (action === undefined) throw new Error("Amazon has no import action.");
  const years = options.years ?? DEFAULT_YEARS;
  const pages: string[] = [];
  const network = fakeNetwork([
    (call) => {
      const url = call.url;
      if (url.pathname === "/ap/exchangetoken/cookies") return json(cookieExchange("amazon.de"));
      pages.push(`${url.pathname}${url.search}`);
      const own = options.override?.({ url, count: pages.length });
      if (own !== undefined) return own;
      if (/^(?:\/-\/en)?\/your-orders\/orders$/.test(url.pathname)) {
        const filter = /^year-(\d{4})$/.exec(url.searchParams.get("timeFilter") ?? "");
        if (filter === null) {
          const listed = options.listed ?? YEARS_LISTED;
          return html(ordersPage([], listed.length === 0 ? {} : { years: listed }));
        }
        const page = listing(years, Number(filter[1]), Number(url.searchParams.get("page") ?? 0));
        return page === undefined ? html("", 404) : html(page);
      }
      if (url.pathname === "/progress-tracker/package") {
        return html(trackPage({ trackingId: "DE0000000077", shortStatus: "IN_TRANSIT" }));
      }
      return html("", 404);
    },
  ]);
  const fake = fakeContext(plugin, network.fetchImpl);
  const controller = new AbortController();
  const batches: ActionBatch[] = [];
  const waits: number[] = [];
  const progress: JobProgress[] = [];
  const checkpoints: unknown[] = [];
  let checkpoint = options.checkpoint;
  const context: ActionContext<AmazonConfig, AmazonSecret | null> = {
    ...fake.base,
    config: { storefront: "amazon.de" },
    secret: { refreshToken: REFRESH, deviceSerial: SERIAL },
    signal: controller.signal,
    checkpoint: {
      load: () => checkpoint,
      save: (value) => {
        checkpoint = JSON.parse(JSON.stringify(value)) as unknown;
        checkpoints.push(checkpoint);
        return Promise.resolve();
      },
    },
    progress: (update) => {
      progress.push(update);
    },
    emit: (batch) => {
      batches.push(batch);
      return Promise.resolve();
    },
    wait: (ms) => {
      waits.push(ms);
      fake.clock.advance(ms);
      options.onWait?.(waits.length, () => {
        controller.abort();
      });
      return Promise.resolve();
    },
  };
  return {
    result: action.run(context, options.input ?? {}),
    pages,
    batches,
    waits,
    progress,
    checkpoints,
    get reports() {
      return fake.unknown;
    },
  };
}

const orderNumbers = (batches: readonly ActionBatch[]): string[] =>
  batches.flatMap((batch) => (batch.orders ?? []).map((order) => order.order.orderNumber));

describe("Amazon import history", () => {
  it("reads every year newest first, page by page, and follows only recent shipments", async () => {
    const job = run();
    expect(await job.result).toEqual({ status: "done", summary: "4 orders, 1 parcels" });
    expect(job.pages).toEqual([
      "/your-orders/orders",
      "/your-orders/orders?timeFilter=year-2026",
      "/progress-tracker/package?orderId=000-2222222-0000001&shipmentId=SHIPNEW1",
      pagingHref(2026, 1).replaceAll("&amp;", "&"),
      "/your-orders/orders?timeFilter=year-2024",
    ]);
    expect(orderNumbers(job.batches)).toEqual([
      "000-2222222-0000001",
      "000-2222222-0000002",
      "000-2222222-0000003",
      "000-2222222-0000004",
    ]);
    const orders = job.batches.flatMap((batch) => batch.orders ?? []);
    expect(orders.map((order) => [order.status, order.at, order.items])).toEqual([
      // On its way, and cancelled: the orders page says so, so old orders end up where they are.
      ["shipped", "2026-11-11T23:00:00.000Z", ["Example mug"]],
      ["delivered", "2026-02-28T23:00:00.000Z", ["Example scarf"]],
      ["cancelled", "2026-02-01T23:00:00.000Z", ["Example board game"]],
      ["delivered", "2024-05-04T22:00:00.000Z", ["Example umbrella"]],
    ]);
    const parcels = job.batches.flatMap((batch) => batch.snapshots ?? []);
    expect(parcels.map((parcel) => [parcel.trackingNumber, parcel.order?.orderNumber])).toEqual([
      ["DE0000000077", "000-2222222-0000001"],
    ]);
    // Paced: no rest before the first page, 6 to 10 s before every other one.
    expect(job.waits).toHaveLength(job.pages.length - 1);
    for (const wait of job.waits) {
      expect(wait).toBeGreaterThanOrEqual(6_000);
      expect(wait).toBeLessThan(10_000);
    }
    expect(job.progress.at(-1)).toEqual({ done: 2, total: 2, phase: "Tracking pages" });
    expect(job.progress[1]).toEqual({ done: 0, total: 2, phase: "2026: page 2" });
    // A checkpoint after every batch, the plan included.
    expect(job.checkpoints).toHaveLength(5);
  });

  it("resumes from its checkpoint without reading a page twice", async () => {
    const first = run({
      onWait: (count, abort) => {
        if (count === 2) abort();
      },
    });
    expect(await first.result).toEqual({ status: "partial", summary: "2 orders, 0 parcels" });
    expect(first.pages).toHaveLength(2);
    const second = run({ checkpoint: first.checkpoints.at(-1) });
    expect(await second.result).toEqual({ status: "done", summary: "4 orders, 1 parcels" });
    expect(second.pages).toEqual([
      "/progress-tracker/package?orderId=000-2222222-0000001&shipmentId=SHIPNEW1",
      pagingHref(2026, 1).replaceAll("&amp;", "&"),
      "/your-orders/orders?timeFilter=year-2024",
    ]);
    expect(orderNumbers([...first.batches, ...second.batches])).toHaveLength(4);
  });

  it("reads only back to the oldest year asked for", async () => {
    const job = run({ input: { since_year: 2025 } });
    expect(await job.result).toEqual({ status: "done", summary: "3 orders, 1 parcels" });
    expect(job.pages.some((page) => page.includes("year-2024"))).toBe(false);
  });

  it("breaks every 25 pages and rests an hour after 300", async () => {
    const many = Array.from({ length: 400 }, (_, index) => [
      { ...IN_2024, orderId: `000-3333333-${String(index).padStart(7, "0")}` },
    ]);
    const job = run({ years: { 2026: [], 2024: many } });
    const result = await job.result;
    expect(result).toEqual({ status: "pause", seconds: 3600, summary: "298 orders, 0 parcels" });
    expect(job.reports).toContain("page:history_year_without_lines");
    expect(job.pages).toHaveLength(300);
    expect(job.waits.filter((wait) => wait === 120_000)).toHaveLength(11);
    expect(job.checkpoints.at(-1)).toMatchObject({
      year: 1,
      page: pagingHref(2024, 298).replaceAll("&amp;", "&"),
    });
  });

  it("stops at a cancel during a rest, with nothing more read", async () => {
    const job = run({
      onWait: (count, abort) => {
        if (count === 1) abort();
      },
    });
    expect(await job.result).toEqual({ status: "partial", summary: "0 orders, 0 parcels" });
    expect(job.pages).toEqual(["/your-orders/orders"]);
  });

  it("reads an odd orders page once more, and stops when it is odd twice", async () => {
    const once = run({
      override: ({ count }) => (count === 1 ? html("<html>Your Orders</html>") : undefined),
    });
    expect(await once.result).toMatchObject({ status: "done" });
    expect(once.waits[0]).toBe(60_000);
    expect(once.reports).toContain("page:history_unexpected_page");

    const twice = run({
      override: ({ url }) => (url.search === "" ? html("<html>Your Orders</html>") : undefined),
    });
    await expect(twice.result).rejects.toBeInstanceOf(PageChangedError);
    expect(twice.pages).toHaveLength(2);
  });

  it("goes back a year at a time when the page lists no years, until a year has no order", async () => {
    const job = run({
      listed: [],
      years: { 2026: [[RECENT], [CANCELLED]], 2025: [[DELIVERED_IN_MARCH]], 2023: [[IN_2024]] },
    });
    expect(await job.result).toEqual({ status: "done", summary: "3 orders, 1 parcels" });
    expect(job.reports).toContain("page:history_no_year_filter");
    expect(job.pages.filter((page) => page.includes("timeFilter"))).toEqual([
      "/your-orders/orders?timeFilter=year-2026",
      pagingHref(2026, 1).replaceAll("&amp;", "&"),
      "/your-orders/orders?timeFilter=year-2025",
      // 2024 shows no order: the job ends there, 2023 is never read.
      "/your-orders/orders?timeFilter=year-2024",
    ]);
    // Going back, the number of years is not known.
    expect(job.progress[0]).toMatchObject({ total: null, phase: "2026: page 1" });
  });

  it("goes back past a current year without orders, and not past the oldest asked for", async () => {
    const job = run({
      listed: [],
      years: { 2025: [[DELIVERED_IN_MARCH]], 2024: [[IN_2024]] },
      input: { since_year: 2025 },
    });
    expect(await job.result).toEqual({ status: "done", summary: "1 orders, 0 parcels" });
    expect(job.pages.filter((page) => page.includes("timeFilter"))).toEqual([
      "/your-orders/orders?timeFilter=year-2026",
      "/your-orders/orders?timeFilter=year-2025",
    ]);
  });

  it("hands a captcha and a refused sign-in to the job, never retrying them", async () => {
    const captcha = run({
      override: ({ count }) => (count === 2 ? html(CAPTCHA_PAGE) : undefined),
    });
    await expect(captcha.result).rejects.toBeInstanceOf(CaptchaError);
    expect(captcha.pages).toHaveLength(2);

    const signedOut = run({ override: () => html(SIGN_IN_PAGE) });
    await expect(signedOut.result).rejects.toBeInstanceOf(SignInRejectedError);
    // The cookies were just minted from the stored sign-in: a sign-in page means it is refused.
    expect(signedOut.pages).toHaveLength(1);
  });

  it("links to the storefront's orders page", () => {
    const manifest = builtinManifest("amazon");
    const link = manifest.actions.find((entry) => entry.id === "open_orders");
    const url = link?.kind === "link" ? link.url : "";
    expect(linkUrl(manifest, url, { storefront: "amazon.co.uk" })).toBe(
      "https://www.amazon.co.uk/your-orders/orders",
    );
  });
});
