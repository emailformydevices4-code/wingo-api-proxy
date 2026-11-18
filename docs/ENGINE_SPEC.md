# WinGo 30S — Verified Live Prediction Engine

## Objective

Build a continuously operating research system for WinGo 30-second results. The system may publish a next-digit estimate only when it has a verified, fresh source observation and a model that has demonstrated out-of-sample skill. It must never fabricate a live result, prediction confidence, or model performance.

## Non-negotiable rules

1. **Source truth:** retain the original source payload, fetch time, source issue, and normalized result. Reject malformed, duplicated, stale, or conflicting observations.
2. **No invented certainty:** a digit probability is an estimate, not a guarantee. If evidence is weak or the feed is stale, publish `HOLD`, not a forced pick.
3. **Causal evaluation:** every historical prediction must use only information available before its target round. No random train/test split and no future leakage.
4. **Reproducibility:** persist model version, feature version, source snapshot, training window, prediction timestamp, target issue, and probability vector.
5. **Independent benchmark:** compare every model with uniform 10% digit probability and simple frequency baselines.
6. **No rule by assumption:** alleged deterministic formulas, PDF tables, MOD rules, cycles, or hidden patterns remain disabled until independently verified on untouched data and prospectively confirmed.
7. **Safe operation:** read-only collection from authorized/public endpoints. Never request or store account passwords, OTPs, session cookies, or payment details.

## Proposed architecture

- **Source adapters:** separate adapter per verified feed; explicit timeout, retry/backoff, response schema checks, source timestamp checks, and health state.
- **Normalizer:** canonical issue ID, digit 0–9, source metadata, and deterministic duplicate handling.
- **Append-only result ledger:** preserve raw payload hash and observation metadata; do not overwrite conflicting source observations silently.
- **Gap monitor:** detect missing, repeated, out-of-order, late, and conflicting issue IDs.
- **Feature pipeline:** rolling digit counts, recency, inter-arrival gaps, transition matrices, n-gram contexts, run lengths, parity/side/color transforms, entropy, autocorrelation, and regime diagnostics. Features are descriptive until they pass causal tests.
- **Model registry:** uniform baseline, smoothed frequency, Bayesian categorical model, Markov/context models with backoff, and optional gradient-boosted or neural challengers only when enough data exists.
- **Walk-forward evaluator:** generate predictions sequentially, score only after the result arrives, and track log loss, Brier score, top-1 accuracy, calibration, and confidence intervals.
- **Ensemble:** weights are learned only from prior out-of-sample performance; cap complexity and shrink toward the uniform baseline.
- **Prediction gate:** require feed freshness, valid target issue, sufficient sample size, positive out-of-sample lift over baseline, calibrated probabilities, and minimum statistical evidence. Otherwise return HOLD.
- **API and dashboard:** expose source health, latest observed round, next target round, one ranked next-digit estimate, all ten probabilities, model contributions, validation metrics, and last verified timestamp.
- **Monitoring:** alert on feed outage, schema drift, gaps, duplicate bursts, stale predictions, calibration drift, and model degradation.

## Prediction contract

A published prediction must include:

- `source_issue` and `target_issue`
- `source_observed_at` and `prediction_created_at`
- `predicted_digit` (0–9) and `probabilities` (exactly ten values summing to 1)
- `model_version`, `feature_version`, and `training_cutoff_issue`
- `sample_count`, `out_of_sample_count`, and benchmark comparison
- `status`: `PREDICTED`, `HOLD`, or `SOURCE_UNAVAILABLE`
- explicit reason whenever status is not `PREDICTED`

A probability distribution is not the same as a reliable edge. The dashboard must not convert weak evidence into a high confidence badge.

## Build sequence

1. Verify a lawful, stable live source and document its exact schema.
2. Implement ingestion, normalization, immutable observations, and health checks.
3. Build replayable historical dataset and gap audit.
4. Implement baseline models and walk-forward evaluation.
5. Add challengers only if they beat baselines on untouched data.
6. Add calibrated ensemble and conservative publication gate.
7. Add API, live dashboard, monitoring, and deployment automation.

## Current blocker

The previously used history endpoint returned HTTP 403 when tested without an authenticated browser session. The game page redirected to its login screen. Therefore live ingestion is not yet verified; no live prediction should be claimed until a permitted source is available and tested.
