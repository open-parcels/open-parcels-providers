import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_NUMBER_CAP, solveAltcha } from "../../../src/carriers/dhl/pl/altcha.js";
import { dhl } from "../../../src/carriers/dhl/index.js";
import { serializeJar, CookieJar } from "../../../src/provider/cookies.js";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
} from "../../../src/provider/errors.js";
import { json, on, World } from "../harness.js";
import { SignInDriver } from "../sign-in-driver.js";

// Made-up shipment numbers, salts and tokens only.
const challenge = (number: number, maxnumber = 50_000) => ({
  algorithm: "SHA-256",
  salt: "testsalt",
  challenge: createHash("sha256")
    .update(`testsalt${String(number)}`)
    .digest("hex"),
  maxnumber,
  signature: "sig",
});
const CHALLENGE = "GET mojdhl.pl/api/dhl/public/auth/captcha/challenge";
const STATUS = "POST mojdhl.pl/api/dhl/public/shipment/status";
const CODE = "10000000000001";
const JWT = "aaa.bbb.ccc";

describe("Altcha proof of work", () => {
  it("finds the number and returns the website's payload", async () => {
    const solved = await solveAltcha(challenge(1234));
    const payload = JSON.parse(Buffer.from(solved, "base64").toString()) as {
      number: number;
      signature: string;
    };
    expect(payload).toMatchObject({ number: 1234, signature: "sig" });
  });

  it("refuses odd shapes, too much work and an exhausted time budget", async () => {
    await expect(solveAltcha({ ...challenge(1), algorithm: "MD5" })).rejects.toThrow(
      UnexpectedResponseError,
    );
    await expect(solveAltcha(challenge(1, MAX_NUMBER_CAP + 1))).rejects.toThrow(
      UnexpectedResponseError,
    );
    await expect(
      solveAltcha(challenge(40_000), { budgetMs: 10, elapsed: () => 11 }),
    ).rejects.toThrow(TransientError);
    await expect(solveAltcha(challenge(60_000, 10))).rejects.toThrow(UnexpectedResponseError);
  });

  it("lets other work run while it searches", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    try {
      await solveAltcha(challenge(20_000));
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

describe("DHL Poland", () => {
  it("looks codes up on Mój DHL behind a solved challenge and drops refused numbers once", async () => {
    const world = new World(dhl, [
      on(CHALLENGE, json(challenge(7)), json(challenge(9))),
      on(
        STATUS,
        json({ errors: { number2: ["invalid"] } }, 422),
        json([
          {
            number: CODE,
            shipments: [
              {
                shipmentNumber: CODE,
                status: "TT_DWP",
                planOfDeliveryFromUtc: "2026-11-18T09:00:00Z",
                shipmentPin: "1234",
              },
            ],
          },
        ]),
      ),
      () => json([]),
    ]);
    const result = await world.track([CODE, "SHORTBUTLONG1"], { regions: ["PL"] });
    const bodies = world.calls
      .filter((call) => call.key === STATUS)
      .map((call) => JSON.parse(call.body ?? "{}") as Record<string, string>);
    expect(bodies[0]?.["captcha-payload"]).toBeTruthy();
    expect(Object.keys(bodies[1] ?? {})).toEqual(["number1", "captcha-payload"]);
    expect(result.snapshots[0]).toMatchObject({
      status: "out_for_delivery",
      expectedFrom: "2026-11-18T09:00:00.000Z",
    });
    expect(JSON.stringify(result.snapshots[0]?.raw)).not.toContain("shipmentPin");
  });

  it("refreshes the cookie session, recovers it once expired and never signs in on its own", async () => {
    const secret = { pl: { deviceId: "dev-1", jar: serializeJar(new CookieJar()) } };
    const world = new World(dhl, [
      on("GET mojdhl.pl/api/dhl/public/auth/refresh", json({}, 401)),
      on("POST mojdhl.pl/api/dhl/public/auth/recover", json({ token: JWT })),
      on(
        "POST mojdhl.pl/api/dhl/public/user/shipment/v2.1/list/incoming/active/1",
        json({ shipments: [{ shipmentNumber: CODE, status: "TT_LK", shipmentPin: "1234" }] }),
      ),
      on(
        "POST mojdhl.pl/api/dhl/public/user/shipment/observed/v1.0/list/incoming/active",
        json([]),
      ),
    ]);
    const result = await world.fetchAccount({ account: "pl" }, secret);
    expect(result.snapshots[0]).toMatchObject({ status: "at_pickup_point", pickup: true });
    expect(world.calls[2]?.headers.get("authorization")).toBe(`Bearer ${JWT}`);
    const expired = new World(dhl, [
      on("GET mojdhl.pl/api/dhl/public/auth/refresh", json({}, 401)),
      on("POST mojdhl.pl/api/dhl/public/auth/recover", json({}, 401)),
    ]);
    await expect(expired.fetchAccount({ account: "pl" }, secret)).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
  });

  it("treats an outage while checking the SMS code as transient, not as a wrong code (OP-085)", async () => {
    const auth = "POST mojdhl.pl/api/dhl/public/auth";
    const world = new World(dhl, [
      on(CHALLENGE, json(challenge(7)), json(challenge(7)), json(challenge(7))),
      on(`${auth}/validate-account`, json({ responseCode: 0 })),
      on(`${auth}/generate-code`, json({ responseCode: 0 })),
      on(`${auth}/validate-code`, json({}, 502)),
    ]);
    const driver = new SignInDriver(world, "pl_account", "account", { account: "pl" });
    await driver.start();
    await driver.continue({ phone: "600000000" });
    await expect(driver.continue({ code: "123456" })).rejects.toBeInstanceOf(TransientError);
  });
});

describe("DHL Poland's public lookup (OP-097)", () => {
  it("fails the run on a 422 that names no number instead of reading every code as not found", async () => {
    const world = new World(dhl, [
      on(CHALLENGE, json(challenge(7))),
      on(STATUS, json({ errors: { captcha: ["invalid"] } }, 422)),
      () => json([]),
    ]);
    await expect(world.track([CODE], { regions: ["PL"] })).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});

describe("DHL Poland with a key for DHL's official API (OP-108, option D)", () => {
  it("asks the official API instead of Mój DHL and computes no proof of work", async () => {
    // Shaped after the Shipment Tracking - Unified documentation's example; values made up.
    const shipment = {
      id: CODE,
      service: "parcel-pl",
      origin: { address: { countryCode: "PL" } },
      destination: { address: { countryCode: "PL" } },
      status: {
        timestamp: "2026-11-18T08:15:00Z",
        statusCode: "transit",
        status: "SHIPMENT IN TRANSIT",
        description: "The shipment is in transit.",
      },
      events: [
        {
          timestamp: "2026-11-18T08:15:00Z",
          statusCode: "transit",
          status: "SHIPMENT IN TRANSIT",
          description: "The shipment is in transit.",
        },
      ],
    };
    const world = new World(dhl, [
      (call) =>
        call.url.hostname === "api-eu.dhl.com" ? json({ shipments: [shipment] }) : undefined,
      () => json([]),
    ]);
    const result = await world.track([CODE], { regions: ["PL"] }, { apiKey: "made-up-key" });
    expect(world.calls.some((call) => call.url.hostname === "mojdhl.pl")).toBe(false);
    expect(result.snapshots[0]).toMatchObject({ trackingNumber: CODE, status: "in_transit" });
  });
});
