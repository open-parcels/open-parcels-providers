import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fedex } from "../../../src/carriers/fedex/index.js";
import { registerBuiltin } from "../../manifests.js";
import { SignInRejectedError, TransientError } from "../../../src/provider/errors.js";
import { fakeContext, fakeNetwork, json, routeTable } from "../harness.js";

// Made-up tracking numbers and keys only; the secret is assembled so no literal is assigned.
const CODE = "990000000001";
const SECRET = { clientId: "test-client", clientSecret: ["made", "up"].join("-") };
const TOKEN = "POST apis.fedex.com/oauth/token";
const TRACK = "POST apis.fedex.com/track/v1/trackingnumbers";
const plugin = registerBuiltin(fedex);

const token = (value: string) => json({ access_token: value, expires_in: 3600 }, 200);

function result(code: string, extra: Record<string, unknown> = {}) {
  return {
    output: {
      completeTrackResults: [
        {
          trackResults: [
            {
              trackingNumberInfo: { trackingNumber: CODE },
              latestStatusDetail: { code, statusByLocale: "On the way" },
              estimatedDeliveryTimeWindow: {
                window: { begins: "2026-11-19T09:00:00-05:00", ends: "2026-11-19T17:00:00-05:00" },
              },
              packageDetails: { weightAndDimensions: { weight: [{ unit: "LB", value: "2.0" }] } },
              scanEvents: [
                {
                  date: "2026-11-18T08:00:00-05:00",
                  eventType: "AR",
                  eventDescription: "Arrived at FedEx location",
                  scanLocation: { city: "EXAMPLETOWN", countryCode: "US" },
                },
                { date: "2026-11-17T08:00:00-05:00", eventType: "OC", eventDescription: "Label" },
              ],
              ...extra,
            },
          ],
        },
      ],
    },
  };
}

describe("FedEx tracking", () => {
  it("signs in with the key, keeps the token and reads status, window, weight and history", async () => {
    const { fetchImpl, calls } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [token("t1")],
          [TRACK]: [json(result("IT"), 200)],
        },
        "host",
      ),
    ]);
    const { base, saved, unknown } = fakeContext(fedex, fetchImpl);
    const [found] = (await plugin.track(base, {}, SECRET, [CODE])).snapshots;
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer t1");
    expect(saved).toHaveLength(1);
    expect(found).toMatchObject({
      carrier: "fedex",
      status: "in_transit",
      rawStatus: "On the way",
      expectedFrom: "2026-11-19T14:00:00.000Z",
      expectedTo: "2026-11-19T22:00:00.000Z",
      weightKg: 0.907,
    });
    expect(found?.history[0]).toEqual({
      at: "2026-11-18T13:00:00.000Z",
      status: "in_transit",
      rawStatus: "Arrived at FedEx location",
      location: "EXAMPLETOWN, US",
    });
    expect(unknown).toEqual([]);
  });

  it("reuses a stored token and renews it once when FedEx refuses it", async () => {
    const keyBase = createHash("sha256").update(SECRET.clientId).digest("hex").slice(0, 16);
    const stored = { base: keyBase, accessToken: "old", expiresAt: Date.parse("2027-01-01") };
    const { fetchImpl, calls } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [token("t2")],
          [TRACK]: [json({}, 401), json(result("DL"), 200)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(fedex, fetchImpl, { session: stored });
    const [found] = (await plugin.track(base, {}, SECRET, [CODE])).snapshots;
    expect(calls.map((call) => call.key)).toEqual([TRACK, TOKEN, TRACK]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer old");
    expect(found).toMatchObject({ status: "delivered", expectedFrom: null });
  });

  it("renews at most once per run, not once per code (OP-086)", async () => {
    const { fetchImpl, calls } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [token("t1"), token("t2"), token("t3")],
          [TRACK]: [json({}, 401), json(result("DL"), 200), json({}, 401)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(fedex, fetchImpl);
    await expect(plugin.track(base, {}, SECRET, [CODE, "990000000002"])).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
    expect(calls.filter((call) => call.key === TOKEN)).toHaveLength(2);
  });

  it("never sends a token stored for another key", async () => {
    const stored = { base: "other", accessToken: "old", expiresAt: Date.parse("2027-01-01") };
    const { fetchImpl, calls } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [token("t2")],
          [TRACK]: [json(result("IT"), 200)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(fedex, fetchImpl, { session: stored });
    await plugin.track(base, {}, SECRET, [CODE]);
    expect(calls.map((call) => call.key)).toEqual([TOKEN, TRACK]);
  });

  it("treats a result that only carries an error as not found", async () => {
    const notFound = {
      output: { completeTrackResults: [{ trackResults: [{ error: { code: "NOTFOUND" } }] }] },
    };
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [token("t1")],
          [TRACK]: [json(notFound, 200)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(fedex, fetchImpl);
    expect((await plugin.track(base, {}, SECRET, [CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown code", async () => {
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [token("t1")],
          [TRACK]: [json(result("ZZ"), 200)],
        },
        "host",
      ),
    ]);
    const { base, unknown } = fakeContext(fedex, fetchImpl);
    expect((await plugin.track(base, {}, SECRET, [CODE])).snapshots[0]?.status).toBeNull();
    expect(unknown).toEqual(["status_code:ZZ"]);
  });

  it("asks for a new key only when FedEx refuses it, never on a network error", async () => {
    const refused = fakeNetwork([routeTable({ [TOKEN]: [json({ errors: [] }, 401)] }, "host")]);
    const first = fakeContext(fedex, refused.fetchImpl);
    await expect(plugin.track(first.base, {}, SECRET, [CODE])).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
    const offline = fakeNetwork([routeTable({ [TOKEN]: [new Error("socket hang up")] }, "host")]);
    const second = fakeContext(fedex, offline.fetchImpl);
    const error: unknown = await plugin
      .track(second.base, {}, SECRET, [CODE])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).not.toBeInstanceOf(SignInRejectedError);
  });
});
