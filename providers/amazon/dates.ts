import {
  parseArrival,
  pastDayOffset,
  wallTimeAt,
  zonedIso,
  type Rules,
} from "../../provider/api.js";
import { foldText } from "./text.js";

/** A calendar day in the page's zone. */
export interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function today(now: Date, timeZone: string): Day {
  const { year, month, day } = wallTimeAt(now.getTime(), timeZone);
  return { year, month, day };
}

function shift(day: Day, days: number): Day {
  const moved = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

const ordinal = (day: Day): number => Date.UTC(day.year, day.month - 1, day.day);

/** ISO 8601 UTC for a wall-clock time on `day` in the page's zone. */
export function localIso(day: Day, hour: number, minute: number, timeZone: string): string {
  return (
    zonedIso({ ...day, hour, minute }, timeZone) ??
    new Date(Date.UTC(day.year, day.month - 1, day.day, hour, minute)).toISOString()
  );
}
function dayOfIso(iso: string): Day | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) {
    return null;
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The delivery window an order line or promise message names, read with the locale tables. */
export function arrivalWindow(
  rules: Rules,
  text: string | null,
  now: Date,
  timeZone: string,
): { from: string; to: string } | null {
  if (text === null || text.trim() === "") {
    return null;
  }
  const window = parseArrival(rules, text, { now, timeZone });
  return window === null ? null : { from: utc(window.from), to: utc(window.to) };
}

/** The tables give local times with their offset; stored times are always UTC. */
function utc(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : new Date(at).toISOString();
}

/**
 * A day in the past named by a timeline header ("Dienstag, 3. November", "Today") or a delivered
 * line ("Delivered 12 November"). The locale tables read dates forward, so a day that lands more
 * than two days ahead is taken to be last year's.
 */
export function pastDay(rules: Rules, text: string, now: Date, timeZone: string): Day | null {
  const reference = today(now, timeZone);
  const words = foldText(text).split(/[\s,]+/);
  for (const word of words) {
    // "Today", "gestern": the locales' standalone past days.
    const offset = pastDayOffset(rules, word);
    if (offset !== undefined) {
      return shift(reference, offset);
    }
  }
  // "Delivered 12 November": the status word in front keeps the tables from matching the date.
  const candidates = [text, text.replace(/^\s*\S+\s+/, "")];
  for (const candidate of candidates) {
    const window = parseArrival(rules, candidate, { now, timeZone });
    const found = window === null ? null : dayOfIso(window.from);
    if (found !== null) {
      return ordinal(found) > ordinal(shift(reference, 2))
        ? { ...found, year: found.year - 1 }
        : found;
    }
  }
  return null;
}

/** "14:23", "2:23 PM" or "2:23 p.m." as hours and minutes. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})\s*([ap])?\.?\s*m?\.?$/i.exec(text.trim());
  if (match === null) {
    return null;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  }
  return hour > 23 || minute > 59 ? null : { hour, minute };
}

/** Month names as the order pages spell them (English and German), by their first letters. */
const MONTH_PREFIXES = [
  ["jan"],
  ["feb"],
  ["mar", "mär"],
  ["apr"],
  ["may", "mai"],
  ["jun"],
  ["jul"],
  ["aug"],
  ["sep"],
  ["oct", "okt"],
  ["nov"],
  ["dec", "dez"],
] as const;

function monthOf(word: string): number | null {
  const folded = foldText(word);
  const index = MONTH_PREFIXES.findIndex((prefixes) =>
    prefixes.some((prefix) => folded.startsWith(prefix)),
  );
  return index === -1 ? null : index + 1;
}

/**
 * The day an order line says the order was placed, with its year: "10 November 2026",
 * "10. November 2026" or "November 10, 2026". Null for anything else.
 */
export function placedDay(text: string | null): Day | null {
  if (text === null) {
    return null;
  }
  const dayFirst = /^(\d{1,2})\.?\s+(\p{L}+)\.?\s+(\d{4})$/u.exec(text.trim());
  const monthFirst = /^(\p{L}+)\.?\s+(\d{1,2}),?\s+(\d{4})$/u.exec(text.trim());
  const [dayText, monthText, yearText] =
    dayFirst !== null
      ? [dayFirst[1], dayFirst[2], dayFirst[3]]
      : monthFirst !== null
        ? [monthFirst[2], monthFirst[1], monthFirst[3]]
        : [undefined, undefined, undefined];
  if (dayText === undefined || monthText === undefined || yearText === undefined) {
    return null;
  }
  const month = monthOf(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  if (month === null || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDate() === day ? { year, month, day } : null;
}

/** Whole days from `day` to `now`'s day in `timeZone`; negative for a day ahead. */
export function daysSince(day: Day, now: Date, timeZone: string): number {
  return Math.round((ordinal(today(now, timeZone)) - ordinal(day)) / 86_400_000);
}
