import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const UPS_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-ups",
    name: "UPS tracking notifications",
    kind: "parcel",
    senders: {
      addresses: ["mcinfo@ups.com", "pkginfo@ups.com", "auto-notify@ups.com"],
    },
    carrier: "ups",
    extract: {
      tracking_number: [
        {
          pattern: "\\b(?<tracking_number>1Z[0-9A-Z]{16})\\b",
        },
      ],
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
        patterns: ["package was delivered|packages were delivered"],
        in: ["subject"],
      },
      {
        status: "problem",
        patterns: ["new scheduled delivery date|exception|delivery attempt"],
        in: ["subject"],
      },
      {
        status: "out_for_delivery",
        patterns: [
          "scheduled for delivery today|follow your delivery on a live map|driver is arriving soon",
        ],
        in: ["subject"],
      },
    ],
    default_status: "in_transit",
    require: ["tracking_number"],
    tests: [
      {
        fixture: "ups-delivered.eml",
        expect: [
          {
            ruleId: "parcel-ups",
            carrier: "ups",
            trackingNumbers: ["1ZA1B2C30312345673"],
            status: "delivered",
          },
        ],
      },
      {
        fixture: "ups-new-date.eml",
        time_zone: "America/New_York",
        expect: [
          {
            ruleId: "parcel-ups",
            trackingNumbers: ["1ZA1B2C30312345673"],
            status: "problem",
            arrival: {
              from: "2026-11-20T00:00:00-05:00",
              to: "2026-11-21T00:00:00-05:00",
              allDay: true,
            },
          },
        ],
      },
    ],
  },
];
