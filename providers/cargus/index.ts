import { z } from "zod";
import {
  InvalidConfigError,
  carrierPattern,
  defineCarrier,
  isoTime,
  SignInRejectedError,
  trackEach,
  unknownReporter,
  text,
  type Json,
  type ParcelSnapshot,
  type ProviderContext,
} from "../../provider/api.js";
import { awbOf, B2C_HOST, CargusAccount } from "./account.js";
import { API_HOST, CARRIER_ID, shortTrace, traceSnapshot } from "./shared.js";

const PLAUSIBLE = carrierPattern(CARRIER_ID);
const ZONE = "Europe/Bucharest";
const SUMMARY_KEYS = ["statusMessage", "status", "statusName", "lastStatus"] as const;

const configSchema = z.looseObject({
  /** The account's phone number; the signed-in backend wants it on every request. */
  phone: z
    .string()
    .trim()
    .transform((value) => (value.startsWith("+") ? "+" : "") + value.replace(/\D/g, ""))
    .pipe(z.string().regex(/^\+?\d{9,15}$/))
    .optional()
    .meta({ title: "Phone number" }),
});
type Config = z.infer<typeof configSchema>;

const secretSchema = z
  .object({
    username: z.string().min(1).meta({ title: "Username" }),
    password: z.string().min(1).meta({ title: "Password" }),
  })
  .nullable();
type Secret = z.infer<typeof secretSchema>;

async function track(context: ProviderContext<Config, Secret>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_text");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code) => {
    const trace = await shortTrace(context.http, code);
    return trace === null ? null : traceSnapshot(trace, report);
  });
}

function outgoing(row: Json): boolean {
  const value = row["isSender"];
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

/** The inbox's arrival times have no date and read 00:00:00 when there is no window. */
function window(
  row: Json,
  parcel: ParcelSnapshot,
): { expectedFrom: string | null; expectedTo: string | null } {
  const none = { expectedFrom: null, expectedTo: null };
  const day =
    text(row["date1"])?.slice(0, 10) ??
    (parcel.status === "out_for_delivery" ? parcel.history[0]?.at.slice(0, 10) : undefined);
  if (parcel.delivered || day === undefined) {
    return none;
  }
  const at = (value: unknown): string | null => {
    const clock = text(value);
    return clock === null || /^00:00(:00)?$/.test(clock)
      ? null
      : isoTime(`${day}T${clock}`, { naive: { zone: ZONE } });
  };
  const expectedFrom = at(row["arrivingTimeFrom"]);
  const expectedTo = at(row["arrivingTimeTo"]);
  return {
    expectedFrom,
    expectedTo:
      expectedTo !== null && (expectedFrom === null || expectedTo > expectedFrom)
        ? expectedTo
        : null,
  };
}

async function fetchAccount(context: ProviderContext<Config, Secret>) {
  if (context.secret === null) {
    throw new SignInRejectedError("The MyCargus account needs an e-mail address and password.");
  }
  const phone = context.config.phone;
  if (phone === undefined) {
    // A missing setting, not a refused sign-in: the user fixes the connection's settings.
    throw new InvalidConfigError("The MyCargus account needs the account's phone number.");
  }
  const report = unknownReporter(context, "status_text");
  const account = new CargusAccount(
    context.http,
    context.secret,
    phone,
    () => context.clock.now().getTime(),
    context.session.load(),
  );
  const snapshots: ParcelSnapshot[] = [];
  let complete: boolean;
  try {
    const inbox = await account.inbox();
    complete = inbox.complete;
    for (const row of inbox.rows) {
      const awb = awbOf(row) ?? "";
      const summary = SUMMARY_KEYS.map((key) => text(row[key])).find((value) => value !== null);
      // The inbox only lists the AWBs; status and history come from the same trace as tracking.
      const trace = (await shortTrace(context.http, awb)) ?? {
        awbBarcode: awb,
        statusMessage: summary ?? null,
        events: [],
      };
      const parcel = traceSnapshot(trace, report, {
        direction: outgoing(row) ? "sending" : "receiving",
      });
      snapshots.push({ ...parcel, ...window(row, parcel), raw: { inbox: row, trace } });
    }
  } finally {
    await account.save(context.session);
  }
  return { snapshots, complete };
}

/** Cargus (Romania): the anonymous trace and the MyCargus account. */
export const cargus = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  configSchema,
  secretSchema,
  signIn: [
    { type: "credentials", kinds: ["account"] },
    { type: "none", kinds: ["tracking"] },
  ],
  http: {
    limits: {
      [API_HOST]: { intervalMs: 5_000, burst: 2 },
      [B2C_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
  fetchAccount,
});
