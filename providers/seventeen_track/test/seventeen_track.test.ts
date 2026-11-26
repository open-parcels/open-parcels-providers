import { describe, expect, it } from "vitest";
import { seventeenTrack } from "../../../src/carriers/seventeen_track/index.js";
import { SignInRejectedError } from "../../../src/provider/errors.js";
import { json, routeTable, World, type Answer } from "../harness.js";

// Made-up numbers and key; the answers follow 17TRACK's API v2.2 shape.
const SECRET = { apiKey: ["made", "up", "key"].join("-") };
const CODE = "EX123456789XX";
const OTHER = "EX987654321XX";
const QUOTA = "POST api.17track.net/track/v2.2/getquota";
const REGISTER = "POST api.17track.net/track/v2.2/register";
const INFO = "POST api.17track.net/track/v2.2/gettrackinfo";

const ok = (data: unknown) => json({ code: 0, data });
const quota = (remain: number, daily = 100, today = 0) =>
  ok({
    quota_total: 100,
    quota_used: 100 - remain,
    quota_remain: remain,
    max_track_daily: daily,
    today_used: today,
  });

function info(code: string, status: string) {
  return {
    number: code,
    carrier: 190001,
    track_info: {
      latest_status: { status, sub_status: `${status}_Other` },
      time_metrics: {
        estimated_delivery_date: { from: "2026-11-20T00:00:00Z", to: "2026-11-21T00:00:00Z" },
      },
      tracking: {
        providers: [
          {
            provider: { key: 190001, name: "Example Post" },
            events: [
              {
                time_utc: "2026-11-18T09:30:00Z",
                description: "Out for delivery",
                location: "Exampletown",
                stage: "OutForDelivery",
              },
              { time_utc: "2026-11-17T08:00:00Z", description: "Accepted", stage: "InfoReceived" },
            ],
          },
        ],
      },
    },
  };
}

function world(table: Record<string, Answer[]>, session?: unknown): World {
  return new World(seventeenTrack, [routeTable(table)], session === undefined ? {} : { session });
}

describe("17TRACK", () => {
  it("registers a new number once, then reads it with gettrackinfo", async () => {
    const w = world({
      [QUOTA]: [quota(10)],
      [REGISTER]: [ok({ accepted: [{ number: CODE }], rejected: [] })],
      [INFO]: [ok({ accepted: [info(CODE, "OutForDelivery")], rejected: [] })],
    });
    const result = await w.track([CODE], {}, SECRET);
    expect(w.requests()).toEqual([QUOTA, REGISTER, INFO]);
    expect(w.calls[1]?.headers.get("17token")).toBe(SECRET.apiKey);
    expect(JSON.parse(w.calls[1]?.body ?? "null")).toEqual([{ number: CODE }]);
    expect(result.asked).toEqual([CODE]);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "17track",
      trackingNumber: CODE,
      status: "out_for_delivery",
      rawStatus: "Out for delivery",
      expectedFrom: "2026-11-20T00:00:00.000Z",
      expectedTo: "2026-11-21T00:00:00.000Z",
    });
    expect(result.snapshots[0]?.history.map((event) => event.status)).toEqual([
      "out_for_delivery",
      "registered",
    ]);
    expect(w.unknown).toEqual([]);
  });

  it("does not register again, and asks again only after six hours", async () => {
    const w = world({
      [QUOTA]: [quota(10)],
      [REGISTER]: [ok({ accepted: [{ number: CODE }], rejected: [] })],
      [INFO]: [
        ok({ accepted: [info(CODE, "InTransit")], rejected: [] }),
        ok({ accepted: [info(CODE, "Delivered")], rejected: [] }),
      ],
    });
    await w.track([CODE], {}, SECRET);
    w.clock.advance(60 * 60 * 1000);
    expect((await w.track([CODE], {}, SECRET)).asked).toEqual([]);
    w.clock.advance(5 * 60 * 60 * 1000);
    const later = await w.track([CODE], {}, SECRET);
    expect(later.snapshots[0]?.status).toBe("delivered");
    expect(w.requests()).toEqual([QUOTA, REGISTER, INFO, INFO]);
  });

  it("registers nothing once the quota is used up, and leaves those numbers' state alone", async () => {
    const w = world({ [QUOTA]: [quota(0)] });
    const result = await w.track([CODE, OTHER], {}, SECRET);
    expect(result.asked).toEqual([]);
    expect(result.snapshots).toEqual([]);
    // Paused: the quota is not even asked again on the next run.
    w.clock.advance(60 * 60 * 1000);
    await w.track([CODE, OTHER], {}, SECRET);
    expect(w.requests()).toEqual([QUOTA]);
  });

  it("registers only as many numbers as today's cap allows", async () => {
    const w = world({
      [QUOTA]: [quota(50, 10, 9)],
      [REGISTER]: [ok({ accepted: [{ number: CODE }], rejected: [] })],
      [INFO]: [ok({ accepted: [info(CODE, "InTransit")], rejected: [] })],
    });
    const result = await w.track([CODE, OTHER], {}, SECRET);
    expect(JSON.parse(w.calls[1]?.body ?? "null")).toEqual([{ number: CODE }]);
    expect(result.asked).toEqual([CODE]);
  });

  it("stops registering when 17TRACK refuses for quota, and counts already registered numbers", async () => {
    const w = world({
      [QUOTA]: [quota(5)],
      [REGISTER]: [
        ok({
          accepted: [],
          rejected: [
            { number: CODE, error: { code: -18019901, message: "has been registered" } },
            { number: OTHER, error: { code: -18019908, message: "Your quota is not enough" } },
          ],
        }),
      ],
      [INFO]: [
        ok({ accepted: [{ number: CODE, track_info: { latest_status: { status: "NotFound" } } }] }),
      ],
    });
    const result = await w.track([CODE, OTHER], {}, SECRET);
    expect(result.asked).toEqual([CODE]);
    // NotFound without events is no answer yet.
    expect(result.snapshots).toEqual([]);
  });

  it("refuses a wrong key as a sign-in problem", async () => {
    const w = world({
      [QUOTA]: [
        json({
          code: -18010002,
          data: { errors: [{ code: -18010002, message: "Invalid security key." }] },
        }),
      ],
    });
    await expect(w.track([CODE], {}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
  });
});
