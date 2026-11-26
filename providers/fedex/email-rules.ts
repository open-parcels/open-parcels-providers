import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const FEDEX_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-fedex",
    name: "FedEx shipment notifications",
    kind: "parcel",
    senders: {
      addresses: ["trackingupdates@fedex.com", "fedexcanada@fedex.com"],
    },
    carrier: "fedex",
    extractors: ["detect_tracking_numbers"],
    extract: {
      arrival: [
        {
          pattern: "(?<arrival>(?:scheduled delivery|estimated delivery|delivery)[^\\n]{0,80})",
          in: ["text"],
        },
      ],
    },
    status_keywords: [
      {
        status: "delivered",
        patterns: ["package has been delivered|packages have been delivered"],
        in: ["subject"],
      },
      {
        status: "problem",
        patterns: ["delivery exception|delayed|unable to deliver"],
      },
      {
        status: "out_for_delivery",
        patterns: ["scheduled for delivery today|out for delivery|delivery scheduled for today"],
      },
    ],
    default_status: "in_transit",
    require: ["tracking_number"],
    tests: [
      {
        fixture: "fedex-out-for-delivery.eml",
        time_zone: "America/Chicago",
        expect: [
          {
            ruleId: "parcel-fedex",
            carrier: "fedex",
            trackingNumbers: ["798765432104"],
            status: "out_for_delivery",
            arrival: {
              from: "2026-11-18T00:00:00-06:00",
              to: "2026-11-18T20:00:00-06:00",
              allDay: false,
            },
          },
        ],
      },
    ],
  },
];
