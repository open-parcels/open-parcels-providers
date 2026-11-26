import { describe, expect, it } from "vitest";
import { paack } from "../../../src/carriers/paack/index.js";
import { InvalidConnectionConfigError } from "../../../src/engine/registry.js";
import { registerBuiltin } from "../../manifests.js";
import { TransientError, UnexpectedResponseError } from "../../../src/provider/errors.js";
import { fakeContext, fakeNetwork, inOrder, raw, type Answer } from "../harness.js";

// Made-up codes and values only.
const CODE = "TEST000000001";
const POSTCODE = "00000";
const plugin = registerBuiltin(paack);
const config = { postalCode: POSTCODE };

function page(label: string, extra: Record<string, unknown> = {}): string {
  const order = {
    orderTrackData: {
      external_id: CODE,
      retailer_name: "Example Shop",
      expected_delivery_ts: { start: "2026-11-18T09:00:00Z", end: "2026-11-18T13:00:00Z" },
    },
    activeEvent: { label, timestamp: "2026-11-18T07:00:00Z" },
    eventList: [
      { label: "created", timestamp: "2026-11-16T10:00:00Z" },
      { label: "receivedAtHub", timestamp: "2026-11-17T10:00:00Z" },
      { label, timestamp: "2026-11-18T07:00:00Z" },
    ],
    ...extra,
  };
  const context = { state: { loaderData: { "routes/tracking.order": order } } };
  return `<html><script>window.__remixContext = ${JSON.stringify(context)};</script></html>`;
}

const html = (body: string) => raw(body, 200, { "content-type": "text/html" });
const JSON_TYPE = { "content-type": "application/json" };
/** Replies in order; once they run out, 404 with an empty body. */
const scripted = (replies: Answer[]) =>
  fakeNetwork([inOrder(...replies)], () => raw("", 404, JSON_TYPE));

describe("Paack public tracking", () => {
  it("reads status, window and history from the embedded route data", async () => {
    const { fetchImpl, calls } = scripted([html(page("inDelivery"))]);
    const { base } = fakeContext(paack, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    const [parcel] = result.snapshots;
    expect(parcel).toMatchObject({
      carrier: "paack",
      trackingNumber: CODE,
      status: "out_for_delivery",
      delivered: false,
      expectedFrom: "2026-11-18T09:00:00.000Z",
      expectedTo: "2026-11-18T13:00:00.000Z",
      sender: "Example Shop",
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(calls[0]?.url.searchParams.get("postal_code")).toBe(POSTCODE);
  });

  it("treats a redirect, a 404 and an error page as not found", async () => {
    const { fetchImpl } = scripted([
      raw("", 302, { ...JSON_TYPE, location: "/error" }),
      raw("", 404, JSON_TYPE),
      html("<html>Order not found</html>"),
    ]);
    const { base } = fakeContext(paack, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE, CODE, CODE]);
    expect(result.snapshots).toEqual([]);
  });

  it("reports a source without any usable postcode as a settings problem (OP-087)", async () => {
    const { fetchImpl, calls } = scripted([]);
    const { base } = fakeContext(paack, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      InvalidConnectionConfigError,
    );
    expect(calls).toHaveLength(0);
  });

  it("asks only the codes it has a postcode for, so the others never read not found", async () => {
    const { fetchImpl, calls } = scripted([html(page("delivered"))]);
    const { base } = fakeContext(paack, fetchImpl);
    const result = await plugin.track(base, { postalCodes: { [CODE]: config.postalCode } }, null, [
      CODE,
      "OTHERCODE0001",
    ]);
    expect(result.asked).toEqual([CODE]);
    expect(calls).toHaveLength(1);
  });

  it("reports an unknown label and leaves the status null", async () => {
    const { fetchImpl } = scripted([html(page("somethingNew"))]);
    const { base, reports: unknown } = fakeContext(paack, fetchImpl);
    const [parcel] = (await plugin.track(base, config, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual([{ kind: "status_code", key: "somethingNew" }]);
  });

  it("fails transiently on network errors and stops on a page without route data", async () => {
    const network = scripted([new Error("offline")]);
    await expect(
      plugin.track(fakeContext(paack, network.fetchImpl).base, config, null, [CODE]),
    ).rejects.toBeInstanceOf(TransientError);
    const odd = scripted([html("<html>maintenance</html>")]);
    await expect(
      plugin.track(fakeContext(paack, odd.fetchImpl).base, config, null, [CODE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
