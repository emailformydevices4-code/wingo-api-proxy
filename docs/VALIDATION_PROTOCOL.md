# Prediction Validation Protocol

## Required evaluation

Use chronological walk-forward evaluation. For each target round, freeze the training data at the last known completed issue, create and persist the probability vector, then score it only after the actual target result is independently observed.

## Baselines

- Uniform digit model: 10% for each digit.
- Expanding-window frequency model with smoothing.
- Recent-window frequency model with smoothing.

Every challenger and ensemble must be compared against these baselines on exactly the same target rounds.

## Metrics

- **Top-1 accuracy:** fraction of exact digit matches.
- **Log loss:** penalizes confident wrong predictions.
- **Multiclass Brier score:** measures probability quality.
- **Calibration:** compare predicted probability buckets with observed hit rates.
- **Coverage:** fraction of rounds where the gate published a prediction rather than HOLD.
- **Lift:** improvement over the strongest baseline, with confidence intervals.
- **Operational freshness:** age of the latest source observation at prediction time.

Do not report only hit rate. A model that predicts one digit with exaggerated confidence can look attractive over a short sample while being poorly calibrated.

## Leakage and integrity controls

- Never train on the target row or any later row.
- Do not use random shuffling for time-series evaluation.
- Keep a permanent record of predictions made before settlement.
- Exclude duplicate issues from scoring and quarantine conflicting results.
- Separate exploratory research from the locked prospective test period.
- Version every feature, model, and threshold.
- Do not tune thresholds on the final holdout.
- Evaluate the digit task directly; BIG/SMALL or colour accuracy does not establish digit accuracy.

## Publication gate

Default to HOLD until all conditions are met:

1. Source is fresh and schema-valid.
2. Target issue is unambiguous and prediction is timestamped before settlement.
3. Minimum sample and out-of-sample counts are met.
4. Probability calibration is acceptable.
5. The model demonstrates statistically supported improvement over the baseline on a locked chronological test.
6. Recent performance has not materially degraded.

Thresholds must be set before evaluating the locked holdout. If any check fails, return HOLD with the failed checks exposed.

## Reporting language

Use “estimated probability” and “historical out-of-sample performance.” Never use “guaranteed,” “sure shot,” “100%,” or imply that a model can know a genuinely random future draw.
