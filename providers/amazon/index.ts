import {
  carrierKey,
  loadRules,
  type Rules,
  defineCarrier,
  pastedRedirect,
  SignInRejectedError,
  type CarrierProvider,
} from "../../provider/api.js";
import { z } from "zod";
import { readAccount, type AmazonConfig } from "./account.js";
import {
  amazonSecretSchema,
  authorizationCode,
  newDeviceSerial,
  newVerifier,
  registerDevice,
  signInStateSchema,
  signInUrl,
  type AmazonSecret,
} from "./auth.js";
import { AMAZON_ID } from "./build.js";
import { AMAZON_EMAIL_RULES } from "./email-rules.js";
import { importHistory } from "./history.js";
import { readLive } from "./live.js";
import { STOREFRONT_IDS, STOREFRONTS } from "./storefronts.js";

const configSchema = z.object({
  storefront: z
    .enum(STOREFRONT_IDS)
    .describe("The Amazon storefront the account orders from.")
    .meta({ title: "Storefront" }),
});

/**
 * One request every five seconds per host, no bursts. A full run costs one orders page plus at
 * most two pages per shipment still moving (capped), so it stays well under a person browsing.
 */
const AMAZON_LIMIT = { intervalMs: 5_000, burst: 1 } as const;

/** The Amazon shop provider. `rules` is loaded on first use unless a test passes its own. */
export function amazonCarrier(rules?: Rules): CarrierProvider<AmazonConfig, AmazonSecret | null> {
  let cached = rules;
  const getRules = (): Rules => (cached ??= loadRules());
  return defineCarrier<AmazonConfig, AmazonSecret | null>({
    id: AMAZON_ID,
    configSchema,
    secretSchema: amazonSecretSchema.nullable(),
    emailRules: AMAZON_EMAIL_RULES,
    signIn: pastedRedirect<AmazonConfig, AmazonSecret | null>({
      start({ config }) {
        const deviceSerial = newDeviceSerial();
        const verifier = newVerifier();
        const storefront = STOREFRONTS[config.storefront];
        return Promise.resolve({
          url: signInUrl(storefront, deviceSerial, verifier),
          state: { deviceSerial, verifier, storefront: storefront.domain },
        });
      },
      async finish({ http }, rawState, pasted) {
        const state = signInStateSchema.parse(rawState);
        const storefront = STOREFRONTS[configSchema.shape.storefront.parse(state.storefront)];
        const code = authorizationCode(pasted);
        if (code === null) {
          throw new SignInRejectedError("The pasted address holds no Amazon authorisation code.");
        }
        return registerDevice(http, storefront, state, code);
      },
    }),
    http: {
      limits: { "*": AMAZON_LIMIT },
      // Pages are read as a mobile browser: the order pages are the website.
      userAgent: {
        value: carrierKey(AMAZON_ID, "browser_user_agent"),
        reason: "Amazon's order pages answer a library User-Agent with a robot check.",
      },
    },
    actions: { import_history: importHistory(getRules) },
    fetchAccount: (context) => readAccount(context, getRules()),
    readLive: (context, target) => readLive(context, target),
  });
}
