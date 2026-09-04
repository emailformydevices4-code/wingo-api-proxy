# Research Notes — v20

## Source fidelity
The PDF source is `dlstudocu.com_wingo-game-refined-combination-analysis.pdf` (27 pages). The extracted table contains 720 unique ordered combinations of three distinct digits from 0–9, each with a predicted digit and colour. The implementation embeds those 720 mappings exactly.

## PDF rule audit
Every embedded mapping was checked against the arithmetic pattern represented by the table: predicted digit = (A+B+C) mod 9, with colour Green for odd and Red for even. All 720 entries matched this audit. The table remains the authoritative supplied rule set; the arithmetic check is only an internal consistency test.

## Evaluation
The PDF engine is evaluated walk-forward. For target observation i, only observations i-3, i-2 and i-1 are used to select the PDF rule. Exact-number accuracy and BIG/SMALL accuracy are reported separately.

## Champion/challenger separation
v7.1 remains the Champion. The PDF engine and House Challenger are independent research streams and do not silently rewrite the Champion's historical scores.

## Randomness research
Runs, autocorrelation and other diagnostics are treated as diagnostics, not proof of predictability. A cryptographic reference stream is a control stream, not a reconstruction of an external generator.

## Reset model
Reset creates a new experiment run. Current-run observations are zeroed for the UI and active dataset. Historical server records remain isolated for audit and are not mixed into the new run.

## Collection limitation
The browser is the live observer. Closing it stops browser observation. A truly continuous collector requires an authorized continuously running service/worker.
