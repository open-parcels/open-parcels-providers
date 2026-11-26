import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const USPS_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-usps",
    name: "USPS tracking notifications",
    kind: "parcel",
    senders: {
      addresses: ["auto-reply@usps.com"],
    },
    carrier: "usps",
    extract: {
      tracking_number: [
        {
          pattern: "\\b(?<tracking_number>9[2345]\\d{18,24})\\b",
        },
      ],
      arrival: [
        {
          pattern: "(?<arrival>expected delivery[^\\n]{0,80})",
        },
      ],
    },
    status_keywords: [
      {
        status: "delivered",
        patterns: ["item delivered"],
        in: ["subject"],
      },
      {
        status: "problem",
        patterns: ["delivery exception|delivery attempt"],
        in: ["subject"],
      },
      {
        status: "at_pickup_point",
        patterns: ["available for pickup"],
      },
      {
        status: "out_for_delivery",
        patterns: ["out for delivery"],
      },
    ],
    default_status: "in_transit",
    require: ["tracking_number"],
    tests: [
      {
        fixture: "usps-out-for-delivery.eml",
        time_zone: "America/Los_Angeles",
        expect: [
          {
            ruleId: "parcel-usps",
            carrier: "usps",
            trackingNumbers: ["9400111200000001234565"],
            status: "out_for_delivery",
            arrival: {
              from: "2026-11-18T00:00:00-08:00",
              to: "2026-11-18T21:00:00-08:00",
              allDay: false,
            },
          },
        ],
      },
    ],
  },
];
