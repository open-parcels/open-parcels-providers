import { z } from "zod";
import { defineCarrier, type ParcelSnapshot, type ProviderContext } from "../../provider/api.js";
import { CARRIER_ID, TRACKING_HOST } from "./shared.js";
import { isPlausibleBarcode, lookUp, trackingSnapshot } from "./tracking.js";

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;

const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: ProviderContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const reportCode = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  const reportText = (sentence: string): void => {
    context.reportUnknown("event_text", sentence);
  };
  for (const barcode of barcodes) {
    if (!isPlausibleBarcode(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(trackingSnapshot(raw, barcode, reportCode, reportText));
    }
  }
  return { snapshots, complete: true };
}

/** Packeta, sold as Zásilkovna in Czechia; one keyless tracking endpoint serves both. */
export const packeta = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
