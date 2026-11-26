import type { EmailRuleDefinition } from "../../provider/api.js";

/**
 * Email rules (format: open-parcels-rules `schema/mail-rule.schema.json`), read by the core's
 * rule engine for the emails routed to this provider. Each rule's `tests` run against the fixtures
 * in `server/test/fixtures/email/` (`server/test/carriers/email-rules.test.ts`).
 */
export const DPD_EMAIL_RULES: readonly EmailRuleDefinition[] = [
  {
    id: "parcel-dpd-de",
    name: "DPD Germany and Austria parcel notifications",
    kind: "parcel",
    senders: {
      domains: ["dpd.de", "dpd.at"],
    },
    carrier: "dpd",
    extractors: ["detect_tracking_numbers"],
    extract: {
      tracking_number: [
        {
          pattern:
            "(?:paketnummer|paketschein|sendungsnummer):?\\s*(?<tracking_number>\\d{14}[0-9A-Z]?)\\b",
        },
      ],
      tracking_url: [
        {
          pattern: '(?<tracking_url>https://(?:tracking|my)\\.dpd\\.(?:de|at)/[^\\s"<>]+)',
          in: ["text", "html"],
        },
      ],
      arrival: [
        {
          pattern: "(?<arrival>(?:zustellung|kommt|voraussichtlich|lieferung)[^\\n]{0,80})",
        },
      ],
    },
    status_keywords: [
      {
        status: "returning",
        patterns: ["retoure|zurück an den absender"],
      },
      {
        status: "problem",
        patterns: [
          "nicht zugestellt|zustellversuch|verzögert|adresse (?:ist )?(?:unvollständig|falsch)",
        ],
      },
      {
        status: "delivered",
        patterns: ["wurde zugestellt|erfolgreich zugestellt|paket zugestellt"],
      },
      {
        status: "at_pickup_point",
        patterns: ["im (?:dpd )?pickup paketshop|zur abholung bereit|abholbereit"],
      },
      {
        status: "out_for_delivery",
        patterns: ["kommt heute|zustellung (?:erfolgt )?heute|in zustellung"],
      },
      {
        status: "in_transit",
        patterns: ["unterwegs|kommt (?:morgen|bald)|paketinfo"],
      },
    ],
    require: ["tracking_number"],
    tests: [
      {
        fixture: "dpd-de-predict.eml",
        time_zone: "Europe/Berlin",
        expect: [
          {
            ruleId: "parcel-dpd-de",
            carrier: "dpd",
            trackingNumbers: ["01505012345678"],
            status: "out_for_delivery",
            arrival: {
              from: "2026-11-18T13:15:00+01:00",
              to: "2026-11-18T14:15:00+01:00",
              allDay: false,
            },
            trackingUrl: "https://tracking.dpd.de/status/de_DE/parcel/01505012345678",
          },
        ],
      },
      {
        fixture: "dpd-de-pickup.eml",
        expect: [
          {
            ruleId: "parcel-dpd-de",
            trackingNumbers: ["05309876543210T"],
            status: "at_pickup_point",
          },
        ],
      },
    ],
  },
];
