// Mock GET /api/redteam/results, for the offline demo (VITE_USE_MOCKS). Sample numbers, not a measurement: the real harness
// (backend/app/redteam) writes demo/redteam-results.json, and this response says source "mock" so the page labels them.
// Shaped like CLAUDE.md's plan: about 200 attacks over
// 5 families mixed with about 200 clean invoices, a baseline Claude agent told to "pay valid invoices" against the
// full pipeline. Jenny's misses here pay the real vendor's verified account (no bank change), so they move no
// money to a scammer; the baseline's misses do.

import type { RedTeamResults } from "@/lib/types";

export const MOCK_REDTEAM: RedTeamResults = {
  source: "mock",
  generated_at: "2026-10-24T02:00:00Z",
  families: [
    {
      family: "bank_change",
      attacks: 40,
      caught_baseline: 6,
      caught_jenny: 40,
      clean_invoices: 40,
      false_positives_baseline: 0,
      false_positives_jenny: 1,
      lost_to_scammers_usd_baseline: 512_480.4,
      lost_to_scammers_usd_jenny: 0,
    },
    {
      family: "poisoned_invoice",
      attacks: 40,
      caught_baseline: 3,
      caught_jenny: 40,
      clean_invoices: 40,
      false_positives_baseline: 0,
      false_positives_jenny: 0,
      lost_to_scammers_usd_baseline: 488_910.15,
      lost_to_scammers_usd_jenny: 0,
    },
    {
      family: "ceo_pressure",
      attacks: 40,
      caught_baseline: 11,
      caught_jenny: 40,
      clean_invoices: 40,
      false_positives_baseline: 1,
      false_positives_jenny: 2,
      lost_to_scammers_usd_baseline: 241_306.77,
      lost_to_scammers_usd_jenny: 0,
    },
    {
      family: "lookalike_domain",
      attacks: 40,
      caught_baseline: 9,
      caught_jenny: 38,
      clean_invoices: 40,
      false_positives_baseline: 0,
      false_positives_jenny: 1,
      lost_to_scammers_usd_baseline: 309_755.02,
      lost_to_scammers_usd_jenny: 0,
    },
    {
      family: "amount_padding",
      attacks: 40,
      caught_baseline: 14,
      caught_jenny: 36,
      clean_invoices: 40,
      false_positives_baseline: 0,
      false_positives_jenny: 3,
      lost_to_scammers_usd_baseline: 0,
      lost_to_scammers_usd_jenny: 0,
    },
  ],
  legit_changes: { total: 4, handled_jenny: 4 },
  median_run_seconds: { baseline: 41, jenny: 63 },
};
