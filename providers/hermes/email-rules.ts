import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const HERMES_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-hermes",
    name: "Hermes Germany parcel notifications",
    kind: "parcel",
    senders: {
      domains: ["myhermes.de", "hermesworld.com"],
    },
    carrier: "hermes",
    extractors: ["detect_tracking_numbers"],
    extract: {
      tracking_number: [
        {
          pattern: "\\b(?<tracking_number>H\\d{19})\\b",
        },
      ],
      tracking_url: [
        {
          pattern: '(?<tracking_url>https://(?:www\\.)?myhermes\\.de/[^\\s"<>]+)',
          in: ["text", "html"],
        },
      ],
      arrival: [
        {
          pattern:
            "(?<arrival>(?:voraussichtlich|zustellung|kommt|lieferung|expected|arriving|delivery)[^\\n]{0,80})",
        },
      ],
    },
    status_keywords: [
      {
        status: "returning",
        patterns: ["rücksendung|retoure|returned to sender"],
      },
      {
        status: "at_pickup_point",
        patterns: [
          "paketshop .{0,40}(?:abholbereit|zur abholung)|abholbereit|ready to collect|parcelshop.{0,40}collect",
        ],
      },
      {
        status: "problem",
        patterns: ["nicht angetroffen|zustellversuch|could not deliver|nicht zustellbar"],
      },
      {
        status: "delivered",
        patterns: [
          "wurde zugestellt|erfolgreich zugestellt|erfolgreiche (?:haustür|nachbarschafts|ablageort)?zustellung|zustellung (?:war )?erfolgreich",
          "haustürzustellung|an der empfangsadresse zugestellt|an einem ablageort hinterlegt",
          "successfully delivered|has been delivered|was delivered|delivered to (?:your|the) (?:door|address|neighbour|safe place)",
        ],
      },
      {
        status: "out_for_delivery",
        patterns: [
          "kommt heute|wird heute zugestellt|with your local (?:hermes )?courier|out for delivery",
        ],
      },
      {
        status: "in_transit",
        patterns: ["ist auf dem weg|unterwegs|on (?:its|the) way"],
      },
    ],
    require: ["tracking_number"],
    tests: [
      {
        fixture: "hermes-de-announced.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "parcel-hermes",
            carrier: "hermes",
            trackingNumbers: ["H1000012000000101001"],
            status: "in_transit",
            arrival: {
              from: "2026-11-20T00:00:00+01:00",
              to: "2026-11-21T00:00:00+01:00",
              allDay: true,
            },
          },
        ],
      },
      {
        fixture: "hermes-de-today.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "parcel-hermes",
            trackingNumbers: ["09123456789013"],
            status: "out_for_delivery",
            arrival: {
              from: "2026-11-18T10:00:00+01:00",
              to: "2026-11-18T13:00:00+01:00",
              allDay: false,
            },
          },
        ],
      },
      {
        fixture: "hermes-de-delivered.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "parcel-hermes",
            carrier: "hermes",
            trackingNumbers: ["H1000012000000101002"],
            status: "delivered",
          },
        ],
      },
      {
        fixture: "hermes-de-delivered-en.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "parcel-hermes",
            carrier: "hermes",
            trackingNumbers: ["H1000012000000101003"],
            status: "delivered",
          },
        ],
      },
    ],
  },
];
