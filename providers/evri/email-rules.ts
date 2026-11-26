import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const EVRI_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-evri",
    name: "Evri parcel notifications",
    kind: "parcel",
    senders: {
      addresses: ["donotreply@myhermes.co.uk"],
      domains: ["evri.com", "myhermes.co.uk"],
    },
    carrier: "evri",
    extractors: ["detect_tracking_numbers"],
    extract: {
      tracking_number: [
        {
          pattern: "\\b(?<tracking_number>H[0-9A-Z]{15}|H\\d{19})\\b",
        },
      ],
      tracking_url: [
        {
          pattern: '(?<tracking_url>https://(?:www\\.)?evri\\.com/[^\\s"<>]+)',
          in: ["text", "html"],
        },
      ],
      arrival: [
        {
          pattern: "(?<arrival>(?:expected|arriving|delivery)[^\\n]{0,80})",
        },
      ],
    },
    status_keywords: [
      {
        status: "returning",
        patterns: ["returned to sender|on its way back"],
      },
      {
        status: "at_pickup_point",
        patterns: ["ready to collect|parcelshop.{0,40}collect|locker.{0,40}collect"],
      },
      {
        status: "problem",
        patterns: ["could not deliver|unable to deliver|missed you"],
      },
      {
        status: "delivered",
        patterns: ["successfully delivered|has been delivered"],
      },
      {
        status: "out_for_delivery",
        patterns: ["with your local (?:evri |hermes )?courier|out for delivery"],
      },
      {
        status: "in_transit",
        patterns: ["on (?:its|the) way"],
      },
    ],
    require: ["tracking_number"],
    tests: [
      {
        fixture: "hermes-uk-delivered.eml",
        expect: [
          {
            ruleId: "parcel-evri",
            carrier: "evri",
            trackingNumbers: ["H1000012000000101001"],
            status: "delivered",
          },
        ],
      },
      {
        fixture: "evri-out-for-delivery.eml",
        expect: [
          {
            ruleId: "parcel-evri",
            carrier: "evri",
            trackingNumbers: ["H01ABC2345678901"],
            status: "out_for_delivery",
          },
        ],
      },
    ],
  },
];
