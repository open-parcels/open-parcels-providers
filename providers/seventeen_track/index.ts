import { z } from "zod";
import {
  defineCarrier,
  isObject,
  isoTime,
  newestFirst,
  objects,
  RecheckLog,
  sessionObject,
  snapshot,
  text,
  type FetchResult,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type ProviderContext,
  type SnapshotEvent,
} from "../../provider/api.js";

import {
  answerOf,
  BATCH,
  call,
  HOST,
  isAlreadyRegistered,
  isNotRegistered,
  isQuotaRejection,
  registrationsLeft,
  type Secret,
} from "./api.js";

export const CARRIER_ID = "17track";

/** Results are asked again at most this often per number (17TRACK updates every few hours). */
const RECHECK_MS = 6 * 60 * 60 * 1000;
/** How long a quota answer is trusted, and how long registering pauses once it is used up. */
const QUOTA_MS = 12 * 60 * 60 * 1000;

const secretSchema = z.object({ apiKey: z.string().min(1).meta({ title: "API key" }) });

/** 17TRACK's main statuses and event stages. */
const STATUSES: Readonly<Record<string, ParcelStatus | null>> = {
  NotFound: null,
  InfoReceived: "registered",
  PickedUp: "in_transit",
  Departure: "in_transit",
  Arrival: "in_transit",
  InTransit: "in_transit",
  OutForDelivery: "out_for_delivery",
  AvailableForPickup: "at_pickup_point",
  Delivered: "delivered",
  DeliveryFailure: "problem",
  Exception: "problem",
  Expired: "problem",
  Returning: "returning",
  Returned: "returning",
};

function statusOf(raw: string | null, report: (key: string) => void): ParcelStatus | null {
  if (raw === null) return null;
  if (!Object.hasOwn(STATUSES, raw)) {
    report(raw);
    return null;
  }
  return STATUSES[raw] ?? null;
}

function history(info: Json, report: (key: string) => void): SnapshotEvent[] {
  const tracking = isObject(info["tracking"]) ? info["tracking"] : {};
  const events: SnapshotEvent[] = [];
  for (const provider of objects(tracking["providers"])) {
    for (const event of objects(provider["events"])) {
      const at =
        isoTime(event["time_utc"], { naive: "utc" }) ??
        isoTime(event["time_iso"], { naive: "reject" });
      const rawStatus = text(event["description"]);
      if (at === null || rawStatus === null) continue;
      events.push({
        at,
        rawStatus,
        status: statusOf(text(event["stage"]), report),
        location: text(event["location"]),
      });
    }
  }
  return newestFirst(events);
}

/** One accepted gettrackinfo entry as a snapshot, or null while 17TRACK has nothing for it. */
export function toSnapshot(entry: Json, report: (key: string) => void): ParcelSnapshot | null {
  const code = text(entry["number"]);
  const info = isObject(entry["track_info"]) ? entry["track_info"] : null;
  if (code === null || info === null) return null;
  const latest = isObject(info["latest_status"]) ? info["latest_status"] : {};
  const main = text(latest["status"]);
  const events = history(info, report);
  if (main === "NotFound" && events.length === 0) return null;
  const status = statusOf(main, report) ?? events[0]?.status ?? null;
  const metrics = isObject(info["time_metrics"]) ? info["time_metrics"] : {};
  const estimate = isObject(metrics["estimated_delivery_date"])
    ? metrics["estimated_delivery_date"]
    : {};
  return snapshot({
    carrier: CARRIER_ID,
    trackingNumber: code,
    status,
    rawStatus: events[0]?.rawStatus ?? main,
    deliveredAt: status === "delivered" ? (events[0]?.at ?? null) : null,
    expectedFrom: isoTime(estimate["from"], { naive: "reject" }),
    expectedTo: isoTime(estimate["to"], { naive: "reject" }),
    history: events,
  });
}

const stateSchema = z.object({
  /** Numbers registered at 17TRACK (registering costs quota, so each is registered once). */
  registered: z.array(z.string()).default([]),
  /** Until when no number is registered: the quota was used up or nothing was left. */
  pausedUntil: z.number().nullable().default(null),
  /** Registrations still allowed, as of `quotaAt`. */
  quotaLeft: z.number().nullable().default(null),
  quotaAt: z.number().nullable().default(null),
});
type State = z.infer<typeof stateSchema>;

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < list.length; start += BATCH)
    out.push(list.slice(start, start + BATCH));
  return out;
}

/** Registrations allowed now, asking 17TRACK's quota at most every {@link QUOTA_MS}. */
async function allowance(context: ProviderContext<unknown, Secret>, state: State, now: number) {
  if (state.pausedUntil !== null && state.pausedUntil > now) return 0;
  if (state.quotaAt === null || now - state.quotaAt >= QUOTA_MS || state.quotaLeft === null) {
    state.quotaLeft = registrationsLeft(await call(context, "getquota", {}));
    state.quotaAt = now;
  }
  if (state.quotaLeft <= 0) state.pausedUntil = now + QUOTA_MS;
  return state.quotaLeft;
}

/** Registers what the quota allows; returns the numbers 17TRACK now follows. */
async function register(
  context: ProviderContext<unknown, Secret>,
  state: State,
  wanted: readonly string[],
  now: number,
): Promise<void> {
  const left = wanted.length === 0 ? 0 : await allowance(context, state, now);
  const known = new Set(state.registered);
  for (const batch of chunks(wanted.slice(0, left))) {
    const answer = answerOf(
      await call(
        context,
        "register",
        batch.map((number) => ({ number })),
      ),
    );
    for (const entry of answer.accepted) {
      const number = text(entry["number"]);
      if (number !== null) known.add(number);
    }
    for (const rejection of answer.rejected) {
      if (isAlreadyRegistered(rejection)) known.add(rejection.number);
      if (isQuotaRejection(rejection)) state.pausedUntil = now + QUOTA_MS;
    }
    state.quotaLeft = Math.max(0, (state.quotaLeft ?? 0) - answer.accepted.length);
    if (state.pausedUntil !== null && state.pausedUntil > now) break;
  }
  state.registered = [...known];
}

async function track(
  context: ProviderContext<unknown, Secret>,
  trackingNumbers: readonly string[],
): Promise<FetchResult> {
  const now = context.clock.now().getTime();
  const stored = sessionObject(context.session);
  const parsed = stateSchema.safeParse(stored["account"] ?? {});
  const state: State = parsed.success ? parsed.data : stateSchema.parse({});
  const log = RecheckLog.from(stored["checked"]);
  const due = log.due(trackingNumbers, now, RECHECK_MS);
  await register(
    context,
    state,
    due.filter((code) => !state.registered.includes(code)),
    now,
  );
  const asked = due.filter((code) => state.registered.includes(code));
  const report = (key: string): void => {
    context.reportUnknown("status", key);
  };
  const snapshots: ParcelSnapshot[] = [];
  const dropped = new Set<string>();
  for (const batch of chunks(asked)) {
    const answer = answerOf(
      await call(
        context,
        "gettrackinfo",
        batch.map((number) => ({ number })),
      ),
    );
    for (const entry of answer.accepted) {
      const found = toSnapshot(entry, report);
      if (found !== null) snapshots.push(found);
    }
    // A number 17TRACK stopped following is registered again on a later run.
    for (const rejection of answer.rejected) {
      if (isNotRegistered(rejection)) dropped.add(rejection.number);
    }
  }
  const tracked = new Set(trackingNumbers);
  state.registered = state.registered.filter((code) => tracked.has(code) && !dropped.has(code));
  log.record(asked, now, trackingNumbers);
  await context.session.save({ ...stored, account: state, checked: log.toJSON() });
  return { snapshots, complete: false, asked };
}

/**
 * 17TRACK, with the user's own API key (API v2.2): numbers are registered once (which costs
 * quota) and then read with gettrackinfo. A fallback: consulted only for parcels no built-in
 * carrier can follow or finds.
 */
export const seventeenTrack = defineCarrier<unknown, Secret>({
  id: CARRIER_ID,
  configSchema: z.looseObject({}),
  secretSchema,
  signIn: { type: "api_key" },
  // 17TRACK allows 3 requests a second; a household needs far less.
  http: {
    limits: { [HOST]: { intervalMs: 2_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
