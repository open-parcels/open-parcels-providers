import { z } from "zod";
import {
  defineCarrier,
  InvalidConfigError,
  type FetchResult,
  type ParcelSnapshot,
  type ProviderContext,
} from "../../provider/api.js";
import { CARRIER_ID, TRACKING_HOST } from "./shared.js";
import { isPlausible, lookUp, trackingSnapshot } from "./tracking.js";

/** Paack only answers for a code together with its delivery postcode. */
const configSchema = z.looseObject({
  /** Postcode used for every code that has no entry in `postalCodes`. */
  postalCode: z.string().trim().min(1).optional().meta({ title: "Postcode" }),
  /** Postcode per tracking code. */
  postalCodes: z
    .record(z.string(), z.string().trim().min(1))
    .optional()
    .meta({ title: "Postcode per tracking number" }),
});
type Config = z.infer<typeof configSchema>;

const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(
  context: ProviderContext<Config, Secret>,
  barcodes: readonly string[],
): Promise<FetchResult> {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  const asked: string[] = [];
  for (const barcode of barcodes) {
    const postalCode = context.config.postalCodes?.[barcode] ?? context.config.postalCode;
    if (postalCode === undefined || !isPlausible(barcode, postalCode)) {
      continue;
    }
    asked.push(barcode);
    const raw = await lookUp(context.http, barcode, postalCode);
    if (raw !== null) {
      snapshots.push(trackingSnapshot(raw, barcode, postalCode, report));
    }
  }
  if (barcodes.length > 0 && asked.length === 0) {
    // Nothing could be asked: a settings problem the connection shows, not "not found" for all.
    throw new InvalidConfigError(
      "Paack needs the delivery postcode: set one for the source, or per tracking code.",
    );
  }
  // Codes without a usable postcode were not asked, so they never read "not found".
  return { snapshots, complete: true, asked };
}

export const paack = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 6_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
