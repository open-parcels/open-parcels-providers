import { z } from "zod";
import {
  defineCarrier,
  isObject,
  isoTime,
  newestFirst,
  objects,
  readJson,
  RecheckLog,
  sessionObject,
  snapshot,
  text,
  TransientError,
  unknownReporter,
  type FetchResult,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type ProviderContext,
  type SnapshotEvent,
} from "../../provider/api.js";

export const CARRIER_ID = "universal_lookup";

/** A code is asked again at most this often, however often the connection runs. */
const RECHECK_MS = 3 * 60 * 60 * 1000;
/** At most this many codes per run; the rest wait for the next run. */
const PER_RUN = 20;

const configSchema = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .describe("Address of the universal-lookup service, for example https://lookup.example.com")
    .meta({ title: "Address" }),
  allow_private_network: z
    .boolean()
    .default(false)
    .describe(
      "On: the address may be on your own network (a LAN address). Off, such an address is refused.",
    )
    .meta({ title: "Allow an address on your own network" }),
});
type Config = z.infer<typeof configSchema>;

/**
 * The service's status words, compared without case, spaces, dashes or underscores. `unknown`
 * is mapped to null on purpose: the service says it has no status.
 */
const STATUSES: Readonly<Record<string, ParcelStatus | null>> = {
  unknown: null,
  notfound: null,
  pending: "registered",
  inforeceived: "registered",
  registered: "registered",
  intransit: "in_transit",
  transit: "in_transit",
  outfordelivery: "out_for_delivery",
  availableforpickup: "at_pickup_point",
  pickup: "at_pickup_point",
  readyforpickup: "at_pickup_point",
  delivered: "delivered",
  exception: "problem",
  deliveryfailure: "problem",
  failedattempt: "problem",
  expired: "problem",
  returned: "returning",
  returning: "returning",
  returntosender: "returning",
};

function statusOf(raw: string | null, report: (key: string) => void): ParcelStatus | null {
  if (raw === null) return null;
  const key = raw.toLowerCase().replace(/[\s_-]+/gu, "");
  if (!Object.hasOwn(STATUSES, key)) {
    report(key);
    return null;
  }
  return STATUSES[key] ?? null;
}

function history(response: Json, report: (key: string) => void): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const event of objects(response["events"])) {
    const at = isoTime(event["date"], { naive: "utc" });
    const rawStatus = text(event["description"]) ?? text(event["status"]);
    if (at === null || rawStatus === null) continue;
    events.push({
      at,
      rawStatus,
      status: statusOf(text(event["status"]), report),
      location: text(event["location"]),
    });
  }
  return newestFirst(events);
}

/** The service's answer for one code as a snapshot, or null when it found nothing. */
export function toSnapshot(
  payload: unknown,
  code: string,
  report: (key: string) => void,
): ParcelSnapshot | null {
  if (!isObject(payload) || payload["success"] !== true || !isObject(payload["response"])) {
    return null;
  }
  const response = payload["response"];
  const events = history(response, report);
  if (events.length === 0 && text(response["status"]) === null) return null;
  const status = statusOf(text(response["status"]), report) ?? events[0]?.status ?? null;
  return snapshot({
    carrier: CARRIER_ID,
    trackingNumber: code,
    status,
    rawStatus: events[0]?.rawStatus ?? text(response["status_description"]),
    deliveredAt: status === "delivered" ? (events[0]?.at ?? null) : null,
    history: events,
  });
}

function lookupUrl(base: string, code: string): URL {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(`api/parcel/${encodeURIComponent(code)}`, root);
}

async function track(
  context: ProviderContext<Config, null>,
  trackingNumbers: readonly string[],
): Promise<FetchResult> {
  const now = context.clock.now().getTime();
  const state = sessionObject(context.session);
  const log = RecheckLog.from(state["checked"]);
  const asked = log.due(trackingNumbers, now, RECHECK_MS).slice(0, PER_RUN);
  const report = unknownReporter(context, "status");
  const snapshots: ParcelSnapshot[] = [];
  for (const code of asked) {
    const response = await context.http.request(lookupUrl(context.config.url, code), {
      headers: { accept: "application/json" },
      timeoutMs: 60_000,
    });
    // The service answers 200 with `success: false` for an unknown code; 404 means the same.
    if (response.status === 404) continue;
    if (response.status !== 200) {
      throw new TransientError(`The universal-lookup service answered HTTP ${response.status}.`);
    }
    const found = toSnapshot(readJson(response, "universal-lookup"), code, report);
    if (found !== null) snapshots.push(found);
  }
  log.record(asked, now, trackingNumbers);
  await context.session.save({ ...state, checked: log.toJSON() });
  return { snapshots, complete: false, asked };
}

/**
 * A universal-lookup service (self-hosted or shared), which asks many carriers and tracking
 * sites at once. A fallback: it is consulted only for parcels no built-in carrier can follow or
 * finds, and only once the user adds the connection with the service's address.
 */
export const universalLookup = defineCarrier<Config, null>({
  id: CARRIER_ID,
  configSchema,
  secretSchema: z.null(),
  signIn: { type: "none" },
  // The service asks several sites per code and takes seconds: one code at a time, unhurried.
  http: { limits: { "*": { intervalMs: 5_000, burst: 1 } } },
  track,
});
