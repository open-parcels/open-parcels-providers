import { describe, expect, it } from "vitest";
import { universalLookup } from "../../../src/carriers/universal_lookup/index.js";
import { TransientError } from "../../../src/provider/errors.js";
import { json, onPrefix, World } from "../harness.js";

// Made-up codes and a made-up service address; the answers follow the service's shape.
const CONFIG = { url: "https://lookup.example.com" };
const CODE = "XX123456789YY";
const OTHER = "ZZ987654321QQ";
const LOOKUP = `GET lookup.example.com/api/parcel/`;

function found(code: string, status: string, events: unknown[]) {
  return json({
    errors: { "example-source": "Timeout" },
    lookup_time: "812ms",
    request: { query: code, type: "parcel" },
    response: {
      couriers: ["Example Post"],
      days_in_transit: "2",
      events,
      status,
      status_description: "On the way",
      tracking_number: code,
    },
    success: true,
  });
}

const notFound = (code: string) =>
  json({
    errors: { "example-source": "Package not found" },
    request: { query: code },
    success: false,
  });

describe("universal lookup", () => {
  it("maps the status and the events of a found code", async () => {
    const world = new World(universalLookup, [
      onPrefix(
        LOOKUP,
        found(CODE, "InTransit", [
          {
            date: "2026-11-17T08:00:00Z",
            description: "Accepted",
            source: "a",
            status: "InfoReceived",
          },
          {
            date: "2026-11-18T09:30:00Z",
            description: "Arrived at the sorting centre",
            source: "a",
            status: "InTransit",
            location: "Exampletown",
          },
        ]),
      ),
    ]);
    const result = await world.track([CODE], CONFIG);
    expect(world.requests()).toEqual([`${LOOKUP}${CODE}`]);
    expect(result.asked).toEqual([CODE]);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "universal_lookup",
      trackingNumber: CODE,
      status: "in_transit",
      rawStatus: "Arrived at the sorting centre",
      delivered: false,
    });
    expect(result.snapshots[0]?.history).toEqual([
      {
        at: "2026-11-18T09:30:00.000Z",
        rawStatus: "Arrived at the sorting centre",
        status: "in_transit",
        location: "Exampletown",
      },
      {
        at: "2026-11-17T08:00:00.000Z",
        rawStatus: "Accepted",
        status: "registered",
        location: null,
      },
    ]);
    expect(world.unknown).toEqual([]);
  });

  it("takes the newest event's status when the service says Unknown, and reports new words", async () => {
    const world = new World(universalLookup, [
      onPrefix(
        LOOKUP,
        found(CODE, "Unknown", [
          {
            date: "2026-11-18T09:30:00Z",
            description: "Delivered to the door",
            status: "Delivered",
          },
          { date: "2026-11-18T07:00:00Z", description: "Something new", status: "Teleported" },
        ]),
      ),
    ]);
    const [parcel] = (await world.track([CODE], CONFIG)).snapshots;
    expect(parcel).toMatchObject({ status: "delivered", delivered: true });
    expect(parcel?.deliveredAt).toBe("2026-11-18T09:30:00.000Z");
    expect(world.unknown).toEqual(["status:teleported"]);
  });

  it("reads success: false as not found", async () => {
    const world = new World(universalLookup, [onPrefix(LOOKUP, notFound(CODE))]);
    const result = await world.track([CODE], CONFIG);
    expect(result.snapshots).toEqual([]);
    expect(result.asked).toEqual([CODE]);
  });

  it("asks about a code at most every three hours, however often it runs", async () => {
    const world = new World(universalLookup, [
      onPrefix(LOOKUP, notFound(CODE), notFound(OTHER), notFound(CODE), notFound(OTHER)),
    ]);
    await world.track([CODE], CONFIG);
    world.clock.advance(60 * 60 * 1000);
    const second = await world.track([CODE, OTHER], CONFIG);
    expect(second.asked).toEqual([OTHER]);
    world.clock.advance(2 * 60 * 60 * 1000);
    const third = await world.track([CODE, OTHER], CONFIG);
    expect(third.asked).toEqual([CODE]);
    expect(world.requests()).toHaveLength(3);
  });

  it("fails the run on an error answer without asking further codes", async () => {
    const world = new World(universalLookup, [onPrefix(LOOKUP, json({}, 502))]);
    await expect(world.track([CODE, OTHER], CONFIG)).rejects.toBeInstanceOf(TransientError);
    expect(world.requests()).toHaveLength(1);
  });

  it("needs the service's address", () => {
    expect(() => world().provider.validateConfig({})).toThrow();
    expect(world().provider.validateConfig(CONFIG)).toEqual({
      ...CONFIG,
      allow_private_network: false,
    });
    expect(world().provider.info.fallback).toBe(true);
  });
});

function world(): World {
  return new World(universalLookup);
}
