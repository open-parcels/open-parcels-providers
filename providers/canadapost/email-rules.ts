import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const CANADAPOST_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-capost",
    name: "Canada Post delivery notifications",
    kind: "parcel",
    senders: {
      addresses: ["donotreply@canadapost.postescanada.ca"],
    },
    carrier: "canadapost",
    extract: {
      tracking_number: [
        {
          pattern: "\\b(?<tracking_number>\\d{16}|[A-Z]{2}\\d{9}CA)\\b",
        },
      ],
    },
    status_keywords: [
      {
        status: "delivered",
        patterns: ["delivery notification|has been delivered|livré"],
        in: ["subject"],
      },
      {
        status: "at_pickup_point",
        patterns: ["ready for pick ?up|pick up at"],
      },
    ],
    default_status: "in_transit",
    tests: [
      {
        fixture: "capost-delivered.eml",
        expect: [
          {
            ruleId: "parcel-capost",
            carrier: "canadapost",
            trackingNumbers: ["7012345678901230"],
            status: "delivered",
          },
        ],
      },
    ],
  },
];
