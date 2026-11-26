import {
  ruleStatus,
  isoTime,
  newestFirst,
  snapshot,
  zonedIso,
  type Json,
  type ParcelSnapshot,
  type SnapshotEvent,
  unescapeHtml,
} from "../../provider/api.js";

export const CARRIER_ID = "ampere";
const ZONE = "Europe/Amsterdam";

const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
/** "Wo 12 aug 21:16": weekday, day, month, time. No year. */
const HISTORY_TIME = /^[A-Za-z]{2}\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})$/;

const decode = (value: string): string => unescapeHtml(value).trim();

/** Text of every element with this `data-test-id`, in page order. */
function allById(html: string, id: string): string[] {
  const pattern = new RegExp(`data-test-id="${id}"[^>]*>\\s*([^<]*?)\\s*<`, "g");
  return [...html.matchAll(pattern)]
    .map((match) => decode(match[1] ?? ""))
    .filter((value) => value !== "");
}

const firstById = (html: string, id: string): string | null => allById(html, id)[0] ?? null;

/**
 * The history as one status and time per `<li>`, read inside the same row: a row without a time
 * keeps its status with a null time instead of shifting every later time by one (OP-095).
 */
function historyRows(html: string): { status: string; time: string | null }[] {
  const rows: { status: string; time: string | null }[] = [];
  for (const row of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
    const status = firstById(row[1] ?? "", "history-entry-status");
    if (status !== null) {
      rows.push({ status, time: firstById(row[1] ?? "", "history-entry-time") });
    }
  }
  return rows;
}

/**
 * The page omits the year: take the current one in Amsterdam, and the year before when that
 * would put the entry more than a day in the future (a late-December entry seen in January).
 */
export function historyTime(value: string, now: Date): string | null {
  const match = HISTORY_TIME.exec(value.trim());
  const month = MONTHS.indexOf((match?.[2] ?? "").toLowerCase()) + 1;
  if (match === null || month === 0) {
    return null;
  }
  const wall = (year: number) =>
    zonedIso(
      { year, month, day: Number(match[1]), hour: Number(match[3]), minute: Number(match[4]) },
      ZONE,
    );
  const year = Number(
    new Intl.DateTimeFormat("en", { timeZone: ZONE, year: "numeric" }).format(now),
  );
  const candidate = wall(year);
  if (candidate !== null && Date.parse(candidate) > now.getTime() + 24 * 60 * 60 * 1000) {
    return wall(year - 1);
  }
  return candidate;
}

export interface PageInput {
  readonly html: string;
  readonly parcelToken: string;
  readonly window: Json;
  readonly now: Date;
}

export function ampereSnapshot(input: PageInput, report: (text: string) => void): ParcelSnapshot {
  const rows = historyRows(input.html);
  const statuses = rows.map((row) => row.status);
  const banner = firstById(input.html, "status-text");
  // History entries are newest first and more complete than the banner, so they win.
  const current = statuses[0] ?? banner;
  for (const value of [
    ...statuses,
    ...(statuses.length === 0 && banner !== null ? [banner] : []),
  ]) {
    if (ruleStatus(CARRIER_ID, value) === null) {
      report(value);
    }
  }
  const status = ruleStatus(CARRIER_ID, current);
  const history: SnapshotEvent[] = [];
  for (const row of rows) {
    const at = row.time === null ? null : historyTime(row.time, input.now);
    if (at !== null) {
      history.push({
        at,
        rawStatus: row.status,
        status: ruleStatus(CARRIER_ID, row.status),
        location: null,
      });
    }
  }
  const delivered = status === "delivered";
  const barcode = firstById(input.html, "barcode-value") ?? input.parcelToken;
  return snapshot({
    carrier: CARRIER_ID,
    trackingNumber: barcode,
    status,
    rawStatus: current,
    delivered,
    deliveredAt: delivered ? historyTime(rows[0]?.time ?? "", input.now) : null,
    expectedFrom: delivered ? null : isoTime(input.window["from"], { naive: { zone: ZONE } }),
    expectedTo: delivered ? null : isoTime(input.window["to"], { naive: { zone: ZONE } }),
    sender: firstById(input.html, "company-name-value") ?? "bol.com",
    receiver: firstById(input.html, "receiver-name"),
    history: newestFirst(history),
    // The page itself is not kept: it holds the address. The parcel token opens nothing alone.
    raw: { barcode, statuses, times: rows.map((row) => row.time), banner, window: input.window },
  });
}
