import { z } from "zod";
import {
  defineAction,
  mapStatus,
  UnexpectedResponseError,
  type ActionContext,
  type ActionResult,
  type OrderSnapshot,
  type ParcelSnapshot,
  type ProviderAction,
  type Rules,
} from "../../provider/api.js";
import {
  deliveredLongAgo,
  groupTiles,
  loadTrack,
  MAX_SHIPMENT_LOADS,
  StorefrontReader,
  type AmazonConfig,
  type Page,
  type PageReader,
} from "./account.js";
import type { AmazonSecret } from "./auth.js";
import { AMAZON_ID, buildSnapshot, isSkipped, readsAsStatus } from "./build.js";
import { daysSince, localIso, placedDay } from "./dates.js";
import {
  nextStartIndex,
  parseOrderTiles,
  parseOrderYears,
  shipmentKey,
  type OrderTile,
} from "./pages.js";
import { loadSession, serializeSession, type AmazonSession } from "./session.js";
import { STOREFRONTS, type Storefront } from "./storefronts.js";

/**
 * "Import history" (decision record 0002 §2.13): every year of the orders page, newest first,
 * page by page. Each page's orders are stored from their order lines alone; only shipments
 * placed recently and not delivered long ago get their tracking pages read, a few per batch.
 * Paced well below a person browsing, with a checkpoint after every batch.
 */

type AmazonActionContext = ActionContext<AmazonConfig, AmazonSecret | null>;

const ORDERS_PATH = "/your-orders/orders";
/** Rest between two page loads: 6 s plus up to 4 s of jitter (the host bucket adds its own). */
const PAGE_REST_MS = 6_000;
const PAGE_JITTER_MS = 4_000;
/** Every this many pages a longer break. */
const BREAK_EVERY_PAGES = 25;
const BREAK_MS = 2 * 60_000;
/** Pages one leg reads; then the job rests an hour and continues on its own. */
const LEG_PAGES = 300;
const LEG_REST_S = 60 * 60;
/** An orders page of an unexpected shape is read once more after this; twice stops the job. */
const SHAPE_RETRY_MS = 60_000;
/** Shipments placed longer ago than this are not followed to their tracking pages. */
const FOLLOW_DAYS = 90;

/** What an import job's leg cannot continue past: the orders page changed shape. */
export class OrdersPageChangedError extends Error {
  override readonly name = "OrdersPageChangedError";
}

/** The job's signal aborted during a rest: the leg ends with what it has. */
class Stopped extends Error {
  override readonly name = "Stopped";
}

const tileSchema = z.object({
  orderId: z.string(),
  lineItemId: z.string(),
  shipmentId: z.string(),
  packageId: z.string(),
  path: z.string(),
  title: z.string(),
  statusText: z.string(),
  note: z.string().nullable(),
  placedText: z.string().nullable(),
  position: z.number(),
  imageUrl: z.string().nullable(),
  returnWindowText: z.string().nullable(),
});

const checkpointSchema = z.object({
  /** The years planned, newest first. */
  years: z.array(z.number().int()),
  /** Index into `years` of the year being read. */
  year: z.number().int().min(0),
  startIndex: z.number().int().min(0),
  /** Pages of the current year read so far, for the phase text. */
  yearPage: z.number().int().min(0),
  /** Shipments whose tracking pages are still to be read. */
  pending: z.array(z.array(tileSchema).min(1)),
  orders: z.number().int().min(0),
  parcels: z.number().int().min(0),
});
type Checkpoint = z.infer<typeof checkpointSchema>;

export const importInputSchema = z.object({
  since_year: z
    .number()
    .int()
    .min(1995)
    .max(2100)
    .optional()
    .describe("Leave empty to read back to the first order.")
    .meta({ title: "Oldest year" }),
});

/** Paces the leg's page loads and counts them. */
class PacedReader implements PageReader {
  pages = 0;

  constructor(
    private readonly context: AmazonActionContext,
    private readonly reader: StorefrontReader,
  ) {}

  async page(path: string): Promise<Page | null> {
    if (this.pages > 0) {
      const rest =
        this.pages % BREAK_EVERY_PAGES === 0
          ? BREAK_MS
          : PAGE_REST_MS + Math.floor(Math.random() * PAGE_JITTER_MS);
      await this.context.wait(rest);
    }
    if (this.context.signal.aborted) {
      throw new Stopped("The job was stopped.");
    }
    this.pages += 1;
    return this.reader.page(path);
  }

  /** An orders page, read once more after a pause when its shape is not what was expected. */
  async ordersPage<T>(path: string, read: (page: Page | null) => T): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return read(await this.page(path));
      } catch (error) {
        if (!(error instanceof UnexpectedResponseError)) throw error;
        if (attempt > 0) throw new OrdersPageChangedError(error.message);
        this.context.reportUnknown("page", "history_unexpected_page");
        await this.context.wait(SHAPE_RETRY_MS);
      }
    }
  }
}

function yearPath(year: number, startIndex: number): string {
  const query = new URLSearchParams({ timeFilter: `year-${String(year)}` });
  if (startIndex > 0) query.set("startIndex", String(startIndex));
  return `${ORDERS_PATH}?${query.toString()}`;
}

/** The order's status as its lines say: delivered when every line still a parcel says so. */
function orderStatus(rules: Rules, tiles: readonly OrderTile[]): OrderSnapshot["status"] {
  const parcels = tiles.filter((tile) => !isSkipped(rules, tile.statusText));
  if (parcels.length === 0) return null;
  const delivered = parcels.every(
    (tile) => mapStatus(rules, AMAZON_ID, { text: tile.statusText })?.status === "delivered",
  );
  return delivered ? "delivered" : null;
}

/** One order report per order on the page, from its lines alone. */
function orderReports(
  rules: Rules,
  storefront: Storefront,
  tiles: readonly OrderTile[],
): OrderSnapshot[] {
  const byOrder = new Map<string, OrderTile[]>();
  for (const tile of tiles) {
    byOrder.set(tile.orderId, [...(byOrder.get(tile.orderId) ?? []), tile]);
  }
  return [...byOrder.entries()].map(([orderNumber, lines]) => {
    const day = placedDay(lines[0]?.placedText ?? null);
    return {
      order: { shop: AMAZON_ID, orderNumber },
      status: orderStatus(rules, lines),
      at: day === null ? null : localIso(day, 0, 0, storefront.timeZone),
      items: lines.map((line) => line.title).filter((title) => title !== ""),
      total: null,
      payment: false,
    };
  });
}

/** Whether a shipment is worth its tracking page: placed recently, not delivered long ago. */
function worthFollowing(rules: Rules, storefront: Storefront, lead: OrderTile, now: Date): boolean {
  const placed = placedDay(lead.placedText);
  if (placed !== null && daysSince(placed, now, storefront.timeZone) > FOLLOW_DAYS) return false;
  return !deliveredLongAgo(rules, lead, now, storefront);
}

/** A shipment's key, from its first line. */
const keyOf = (group: readonly OrderTile[]): string =>
  group[0] === undefined ? "" : shipmentKey(group[0]);

class HistoryImport {
  readonly #storefront: Storefront;
  readonly #session: AmazonSession;
  readonly #reader: StorefrontReader;
  readonly #paced: PacedReader;

  constructor(
    private readonly context: AmazonActionContext,
    private readonly rules: Rules,
  ) {
    this.#storefront = STOREFRONTS[context.config.storefront];
    this.#session = loadSession(context.session.load());
    this.#reader = new StorefrontReader(context, this.#storefront, this.#session);
    this.#paced = new PacedReader(context, this.#reader);
  }

  summary(state: Checkpoint): string {
    return `${String(state.orders)} orders, ${String(state.parcels)} parcels`;
  }

  /** Reads the years the account has orders in. */
  async plan(sinceYear: number | undefined): Promise<Checkpoint> {
    const years = await this.#paced.ordersPage(ORDERS_PATH, (page) => {
      const listed = page === null ? [] : parseOrderYears(page.body);
      if (listed.length === 0) {
        throw new UnexpectedResponseError("Amazon's orders page lists no years.");
      }
      return listed;
    });
    return {
      years: years.filter((year) => sinceYear === undefined || year >= sinceYear),
      year: 0,
      startIndex: 0,
      yearPage: 0,
      pending: [],
      orders: 0,
      parcels: 0,
    };
  }

  /** Reads the tracking pages of a few pending shipments and stores their parcels. */
  async follow(state: Checkpoint): Promise<Checkpoint> {
    const now = this.context.clock.now();
    const batch = state.pending.slice(0, MAX_SHIPMENT_LOADS);
    const snapshots: ParcelSnapshot[] = [];
    for (const tiles of batch) {
      const lead = tiles[0];
      if (lead === undefined) continue;
      const loaded = await loadTrack(this.context, this.#paced, lead);
      const built = buildSnapshot({
        rules: this.rules,
        storefront: this.#storefront,
        tiles,
        ...loaded,
        now,
        report: (kind, value) => {
          this.context.reportUnknown(kind, value);
        },
      });
      if (built !== null) snapshots.push(built);
    }
    await this.context.emit({ snapshots });
    return {
      ...state,
      pending: state.pending.slice(batch.length),
      parcels: state.parcels + snapshots.length,
    };
  }

  /** Reads the next page of the current year and stores its orders. */
  async readPage(state: Checkpoint): Promise<Checkpoint> {
    const year = state.years[state.year];
    if (year === undefined) return state;
    const { tiles, next } = await this.#paced.ordersPage(
      yearPath(year, state.startIndex),
      (page) => {
        if (page === null) {
          throw new UnexpectedResponseError("Amazon's orders page for a year was not found.");
        }
        const lines = parseOrderTiles(page.body, (text) => readsAsStatus(this.rules, text));
        return {
          tiles: lines,
          next: lines.length === 0 ? null : nextStartIndex(page.body, state.startIndex),
        };
      },
    );
    if (tiles.length === 0 && state.startIndex === 0) {
      // A year the filter offers without physical orders (digital ones are listed elsewhere).
      this.context.reportUnknown("page", "history_year_without_lines");
    }
    const now = this.context.clock.now();
    const follow = [...groupTiles(this.rules, tiles).values()].filter((group) => {
      const lead = group[0];
      return lead !== undefined && worthFollowing(this.rules, this.#storefront, lead, now);
    });
    const orders = orderReports(this.rules, this.#storefront, tiles);
    await this.context.emit({ orders });
    const known = new Set(state.pending.map(keyOf));
    return {
      ...state,
      ...(next === null
        ? { year: state.year + 1, startIndex: 0, yearPage: 0 }
        : { startIndex: next, yearPage: state.yearPage + 1 }),
      pending: [...state.pending, ...follow.filter((group) => !known.has(keyOf(group)))],
      orders: state.orders + orders.length,
    };
  }

  async save(state: Checkpoint): Promise<void> {
    // Cookies minted here replace the stored ones; otherwise the polling runs' session stays.
    if (this.#reader.minted) {
      await this.context.session.save(serializeSession(this.#session));
    }
    await this.context.checkpoint.save(state);
    const year = state.years[state.year];
    this.context.progress({
      done: state.year,
      total: state.years.length,
      phase:
        year === undefined
          ? "Tracking pages"
          : `${String(year)}: page ${String(state.yearPage + 1)}`,
    });
  }

  async run(saved: Checkpoint | undefined, sinceYear: number | undefined): Promise<ActionResult> {
    let state = saved;
    try {
      await this.#reader.ensureCookies();
      if (state === undefined) {
        state = await this.plan(sinceYear);
        await this.save(state);
      }
      while (state.year < state.years.length || state.pending.length > 0) {
        if (this.context.signal.aborted) {
          return { status: "partial", summary: this.summary(state) };
        }
        if (this.#paced.pages >= LEG_PAGES) {
          return { status: "pause", seconds: LEG_REST_S, summary: this.summary(state) };
        }
        state = state.pending.length > 0 ? await this.follow(state) : await this.readPage(state);
        await this.save(state);
      }
      return { status: "done", summary: this.summary(state) };
    } catch (error) {
      if (error instanceof Stopped && state !== undefined) {
        return { status: "partial", summary: this.summary(state) };
      }
      throw error;
    }
  }
}

/** The "Import history" action of the Amazon provider. */
export function importHistory(
  getRules: () => Rules,
): ProviderAction<AmazonConfig, AmazonSecret | null> {
  return defineAction({
    input: importInputSchema,
    run(context: AmazonActionContext, input) {
      const saved = checkpointSchema.safeParse(context.checkpoint.load());
      return new HistoryImport(context, getRules()).run(
        saved.success ? saved.data : undefined,
        input.since_year,
      );
    },
  });
}
