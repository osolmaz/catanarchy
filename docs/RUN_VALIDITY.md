# Run validity

## Rule

Only a run whose package marks it valid counts as evidence. Ignore every other run, even a finished one. A finished run can still hold a harness defect, and a stopped run holds a short game.

## Criteria

A run is valid when all three conditions hold:

- the run finished, so the manifest status is `completed`;
- no decision was lost to an empty time pool; and
- no replaced decision took an action that spends resources.

### The empty time pool

Each turn key holds one exploration pool and each decision holds one finalization pool. When either pool reaches zero the harness makes no provider request and replaces the decision. A run from commit `3685b13` records `pool` and `remainingMs` on the failed decision, so the loss is a stated fact.

For an earlier run the loss shows as a failed attempt that made no request, so it spent no tokens and returned in under 2 ms. The marker records those two counts apart: `emptyPoolRecorded` and `emptyPoolInferred`.

### The spending replacement

Before commit `3685b13` a failed seat fell back to the first legal action, and the engine lists builds, trades, and development cards before `end-turn`. Such a replacement spends a card or a resource that the seat never chose to spend, so the game it produced is not the game the seat played.

A neutral replacement does not invalidate a run. The harness now ends the turn, rolls when the roll is owed, or moves the robber in that case.

## The mark

Every published package holds `VALIDITY.json`:

```json
{
  "schema": "catanarchy.run-validity.v1",
  "runId": "terra-high10-seed47-a",
  "valid": false,
  "criteria": "A run is valid when it finished and no decision was lost to an empty time pool and no replaced decision spent resources.",
  "evidence": {
    "status": "completed",
    "emptyPoolDecisions": 0,
    "emptyPoolRecorded": 0,
    "emptyPoolInferred": 0,
    "replacedDecisions": 3,
    "spendingReplacements": 1
  },
  "reasons": ["1 replaced decision took an action that spends resources"],
  "markedAt": "2026-09-14"
}
```

The `evidence` block states the count behind each reason, so a reader can check the mark against the timeline. The file is part of the package, so its hash is in `CHECKSUMS.sha256`.

A package that holds no `VALIDITY.json` is not marked, and a run in it does not count as evidence.

## Published runs

Sixteen of the thirty-three published packages are valid.

| Package                          | Cell                                                             | Valid | Reason                                                                                     |
| -------------------------------- | ---------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------ |
| `luna-mixed-seed47-a`            | luna `high`, 10 min window, grace 60 s                           | yes   |                                                                                            |
| `luna-mixed-seed47-b`            | luna `high`, 10 min window, grace 60 s                           | yes   |                                                                                            |
| `luna-xhigh-seed47-a`            | luna `xhigh`, 10 min window, grace 60 s                          | yes   |                                                                                            |
| `luna-xhigh-seed47-b`            | luna `xhigh`, 10 min window, grace 60 s                          | yes   |                                                                                            |
| `sol-high10-g300-seed47-a`       | sol `high`, 10 min window, grace 300 s                           | yes   |                                                                                            |
| `sol-high10-g300-seed47-b`       | sol `high`, 10 min window, grace 300 s                           | yes   |                                                                                            |
| `sol-max30-g300-seed47-a`        | sol `max`, 30 min window, grace 300 s                            | yes   |                                                                                            |
| `sol-max30-g300-seed47-b`        | sol `max`, 30 min window, grace 300 s                            | yes   |                                                                                            |
| `terra-high-vs-ds-high-seed47-a` | terra `high` against DeepSeek `high`, 30 min window, grace 300 s | yes   |                                                                                            |
| `terra-high-vs-ds-high-seed47-b` | terra `high` against DeepSeek `high`, 30 min window, grace 300 s | yes   |                                                                                            |
| `terra-high-vs-ds-max-seed47-a`  | terra `high` against DeepSeek `max`, 30 min window, grace 300 s  | yes   |                                                                                            |
| `terra-high-vs-ds-max-seed47-b`  | terra `high` against DeepSeek `max`, 30 min window, grace 300 s  | yes   |                                                                                            |
| `terra-max-seed47-a`             | terra `max`, 10 min window, grace 60 s                           | yes   |                                                                                            |
| `terra-max30-fixed-seed47-a`     | terra `max`, 30 min window, grace 300 s                          | yes   |                                                                                            |
| `terra-max30-fixed-seed47-b`     | terra `max`, 30 min window, grace 300 s                          | yes   |                                                                                            |
| `terra-max30-g300-seed47-a`      | terra `max`, 30 min window, grace 300 s                          | yes   |                                                                                            |
| `terra-high10-seed47-a`          | terra `high`, 10 min window, grace 60 s                          | no    | 1 replaced decision took an action that spends resources                                   |
| `terra-high10-seed47-b`          | terra `high`, 10 min window, grace 60 s                          | no    | 1 replaced decision took an action that spends resources                                   |
| `terra-max-seed47-b`             | terra `max`, 10 min window, grace 60 s                           | no    | the empty time pool removed 31 decisions; 11 spending replacements                         |
| `terra-max-vs-ds-max-seed47-a`   | terra `max` against DeepSeek `max`, 30 min window, grace 300 s   | no    | the run did not finish; the empty time pool removed 16 decisions                           |
| `terra-max-vs-ds-max-seed47-b`   | terra `max` against DeepSeek `max`, 30 min window, grace 300 s   | no    | the empty time pool removed 13 decisions                                                   |
| `terra-max30-g300-seed47-b`      | terra `max`, 30 min window, grace 300 s                          | no    | the empty time pool removed 14 decisions; 11 spending replacements                         |
| `terra-max30-seed47-a`           | terra `max`, 30 min window, grace 60 s                           | no    | the empty time pool removed 17 decisions; 8 spending replacements                          |
| `terra-max30-seed47-b`           | terra `max`, 30 min window, grace 60 s                           | no    | the run did not finish; the empty time pool removed 22 decisions; 10 spending replacements |
| `terra-seed47-a`                 | terra `high`, 10 min window, grace 60 s                          | no    | the run did not finish                                                                     |
| `terra-seed47-b`                 | terra `high`, 10 min window, grace 60 s                          | no    | the run did not finish                                                                     |
| `sol-high10-seed47-a`            | sol `high`, 10 min window, grace 60 s                            | no    | the run did not finish                                                                     |
| `sol-high10-seed47-b`            | sol `high`, 10 min window, grace 60 s                            | no    | the run did not finish                                                                     |
| `sol-max30-seed47-a`             | sol `max`, 30 min window, grace 60 s                             | no    | the run did not finish                                                                     |
| `sol-max30-seed47-b`             | sol `max`, 30 min window, grace 60 s                             | no    | the run did not finish                                                                     |
| `v41-full-seed47`                | DeepSeek baseline, four seats                                    | no    | 8 replaced decisions took an action that spends resources                                  |

Two further paths, `terra-high-seed47-stopped-a` and `terra-high-seed47-stopped-b`, are copies of `terra-seed47-a` and `terra-seed47-b`. They carry the same mark.

The invalid runs stay published as labelled evidence. A reader can inspect what the harness did, and the mark states why the run does not count.

## Marking a run again

The mark follows from the timeline, not from a human preference. To mark a package again, count the three conditions from `timeline.jsonl` and `analysis.json`, write `VALIDITY.json`, rewrite `CHECKSUMS.sha256`, and sync the package path to the bucket.

The tool that wrote these marks is `validity-mark.py` in the local scratch tools. It reads the package list, computes the three conditions, and applies the marks with `--apply`.

## Related documents

- [Run log](RUN_LOG.md) states the decision records that hold the evidence.
- [Agent harness](AGENT_HARNESS.md) states the time pools, the grace, and the neutral replacement rule.
- [Level and time-window seed 47 run report](2026-09-13-level-and-window-seed-47.md) holds the cells that these packages belong to.
- [Level cells on seed 47](2026-09-14-level-cells-seed-47.md) holds the six cell games and the `max` finding.
