---
title: "Level cells on seed 47: terra against DeepSeek at high and max"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: 2026-09-14
tags: ["agents", "run-report", "thinking-level", "time-budget", "failure-analysis"]
---

This report covers six games on board seed 47. `openai/gpt-5.6-terra` plays `huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita` in three cells, with the seats swapped inside each cell. Cell A holds both seats at `high`, cell B holds both at `max`, and cell C holds terra at `high` and DeepSeek at `max`. The cells exist to separate the two levels, because the earlier reports changed a level and a time window at the same time.

Terra won both games of cell A. Cell C split one game each. Cell B produced no valid result: terra lost 16 and 13 decisions to the empty time pool, and a few further failures named an expired finalization time with a remaining time under one millisecond. The operator stopped the first game after ten hours. The result of cell B is a statement about the `max` level under a 300-second finalization grace, not a statement about which model plays better.

DeepSeek still leads the series. Across the sixteen valid head-to-head games on seed 47, DeepSeek won nine, terra four, and sol three.

Two games for one cell are a behavioural case study. They are not a strength verdict. About 85 games are needed to detect a win-rate shift from 50% to 65%.

## The cells

| Cell | terra level | DeepSeek level | Level config                     | Wire values                   |
| ---- | ----------- | -------------- | -------------------------------- | ----------------------------- |
| A    | `high`      | `high`         | `config/thinking-levels.json`    | terra `high`, DeepSeek `high` |
| B    | `max`       | `max`          | `config/cells/deepseek-max.json` | terra `max`, DeepSeek `max`   |
| C    | `high`      | `max`          | `config/cells/terra-high.json`   | terra `high`, DeepSeek `max`  |

Terra sends the level as `reasoning.effort` on the Responses API, and DeepSeek sends it as `reasoning_effort` on the chat-completions API. The base config holds the run pin that keeps DeepSeek at `high`, so cell B and cell C name their own level map and leave the base file alone.

Cell A and cell B each change one variable against the reference cell of the earlier set, which is terra at `max` against DeepSeek at `high`. Cell C moves both levels, so it completes the two-by-two shape but cannot attribute a difference to one seat.

## Run identity

Every run used seed 47, four seats, one negotiation round, eight planning steps, a 131,072-token context window, a 30-minute turn window, a decision bound of 2000, and a cost ceiling of $232. The finalization grace was the harness default of 300 seconds. No run reached its decision bound or its cost ceiling.

| Run                              | Levels sent             | Status    | Turns | Decisions | Failed | Clock losses |     Cost | Active time | Winner        | Valid |
| -------------------------------- | ----------------------- | --------- | ----: | --------: | -----: | -----------: | -------: | ----------: | ------------- | ----- |
| `terra-high-vs-ds-high-seed47-a` | terra `high`, DS `high` | Completed |    62 |       527 |     12 |            0 |  $7.5314 |      74.4 m | terra         | yes   |
| `terra-high-vs-ds-high-seed47-b` | terra `high`, DS `high` | Completed |    85 |       720 |     16 |            0 | $11.1222 |      93.5 m | terra         | yes   |
| `terra-max-vs-ds-max-seed47-a`   | terra `max`, DS `max`   | Partial   |    64 |       587 |     79 |           16 | $12.8939 |     588.7 m | none, stopped | no    |
| `terra-max-vs-ds-max-seed47-b`   | terra `max`, DS `max`   | Completed |    73 |       619 |     48 |           13 | $14.0645 |     588.7 m | terra         | no    |
| `terra-high-vs-ds-max-seed47-a`  | terra `high`, DS `max`  | Completed |    69 |       602 |     65 |            0 |  $8.0552 |     234.5 m | DeepSeek      | yes   |
| `terra-high-vs-ds-max-seed47-b`  | terra `high`, DS `max`  | Completed |    73 |       677 |     92 |            0 |  $9.7817 |     418.5 m | terra         | yes   |

The four games of cell A and cell C are valid. Both games of cell B are invalid, because the clock removed decisions. `terra-max-vs-ds-max-seed47-b` finished at 16:50:28 UTC, during the operator stop of the pair.

## Result

| Cell | Winner          | terra wins | DeepSeek wins | Note                                 |
| ---- | --------------- | ---------: | ------------: | ------------------------------------ |
| A    | terra           |          2 |             0 |                                      |
| B    | no valid result |          0 |             0 | terra lost 29 decisions to the clock |
| C    | split           |          1 |             1 |                                      |

The score line of each game, from the standings at the end:

- Cell A, game `-a`: terra 10, DeepSeek 7. The winner seat was white, which the manifest maps to terra.
- Cell A, game `-b`: terra 10, DeepSeek 9.
- Cell B, game `-b`: terra 10, DeepSeek 8, but the game is invalid.
- Cell B, game `-a`: stopped at turn 64 with terra on 9 and DeepSeek on 6.
- Cell C, game `-a`: DeepSeek 10, terra 7.
- Cell C, game `-b`: terra 10, DeepSeek 7.

## What the `max` level did

The failures divide by level, not by model.

| Cell | Levels                  | Failed attempts | Clock losses | Where the losses sit |
| ---- | ----------------------- | --------------: | -----------: | -------------------- |
| A    | terra `high`, DS `high` |          12, 16 |            0 |                      |
| B    | terra `max`, DS `max`   |          79, 48 |       16, 13 | every one on terra   |
| C    | terra `high`, DS `max`  |          65, 92 |            0 |                      |

Two different things happen at `max`.

- DeepSeek at `max` fails often, but it never loses the clock. Its 59 and 89 failed attempts are the message "The model did not select a legal action during finalization" or its negotiation form. With one attempt for each decision, the harness replaces the decision at once, and the seat keeps playing. The failure costs the seat its move, not its turn.
- Terra at `max` loses the clock. Each lost decision waited about eleven minutes for a reply that held 32 output tokens, with about 257,000 cached input tokens. The record then shows an empty time pool, and the harness ends the turn or rolls. One such loss happened in each of the last turns of both games.

So a `max` seat that answers slowly is not playable under a 300-second finalization grace once its context is large. That is the level rule in `AGENTS.md` in action: a lower level is allowed when the deepest level makes the game unplayable, and the reason belongs in the launch record. Cell B is the recorded example.

The two failures also differ in kind. In cell C, DeepSeek answered the wrong way 59 and 89 times and still lost only one game of two. In cell B, terra answered nothing at all inside the grace 29 times and lost the game to the clock.

## Incident: four games killed by a session reap

The six games started between 07:00 and 07:03 UTC. The two cell A games finished at 08:14 and 08:34.

At about 09:00 UTC every agent session was reaped, and the four running games died with their sessions. The two finished games were safe.

The operator resumed the four games in warm mode at 09:16:52 UTC, from indices 1075, 1056, 1374, and 1566. A warm resume replays the log, rebuilds the position, and continues the same run. The resume also carries the spend of the records it drops, so the budget base stays correct. The four resumes recorded no error.

`AGENTS.md` now requires a detached background launch, with `setsid nohup`, so a session reap cannot kill a game again. The operator stop of cell B, and the resume, both follow that rule.

## The stop

The operator stopped the cell B pair at 16:50 UTC, ten hours after the start, with these reasons:

- Both games were already invalid, because the clock removed 29 of terra's decisions.
- Game `-a` had held at 64 turns for over an hour and kept spending money on a game that could not become evidence.
- The budget was better spent on a cell B rerun with a longer finalization grace.

`terra-max-vs-ds-max-seed47-b` had already completed. Game `-a` keeps its records as a labelled partial run. A partial package of this kind holds the position at the stop, and its `analysis.json` states that position.

A rerun of cell B needs a longer grace, for example 900 seconds, because the lost decisions each waited about eleven minutes. The rerun is not part of this report.

## Cost

| Run                              |     Cost | Cost for each turn |
| -------------------------------- | -------: | -----------------: |
| `terra-high-vs-ds-high-seed47-a` |  $7.5314 |             $0.121 |
| `terra-high-vs-ds-high-seed47-b` | $11.1222 |             $0.131 |
| `terra-max-vs-ds-max-seed47-a`   | $12.8939 |             $0.201 |
| `terra-max-vs-ds-max-seed47-b`   | $14.0645 |             $0.193 |
| `terra-high-vs-ds-max-seed47-a`  |  $8.0552 |             $0.117 |
| `terra-high-vs-ds-max-seed47-b`  |  $9.7817 |             $0.134 |

The six games cost $63.4489 together. The campaign stands at $327.5643 of the recorded $400 ceiling, which leaves $72.44. The per-game stop for these runs is $19.84, the difference between the $232 ceiling and the $212.1646 worst-case request. No game reached its stop.

The `max` cells cost about $0.20 for each turn, against $0.12 to $0.13 for the `high` cells, because a `max` turn holds more decisions and longer waits.

## Validity

A run counts as evidence only when its package holds a `VALIDITY.json` with `valid: true`. Each of the six packages carries its mark, and `docs/RUN_VALIDITY.md` holds the table and the criteria.

- Valid: both cell A games, both cell C games.
- Invalid: both cell B games. `terra-max-vs-ds-max-seed47-a` is also partial. The marks cite the empty time pool, and they state the counts.

The validity count reads the recorded empty pool, which the harness counts as a remaining time of exactly zero. In cell B, a few further failures name an expired finalization time with a remaining time under one millisecond. The harness keeps those out of its own count, and the marks follow the harness.

## What this sample supports

- Terra beat DeepSeek in both games at `high` against `high`. Two games cannot separate the models, and the earlier reference cell went the other way, with DeepSeek winning three of four against terra at `max`.
- DeepSeek at `max` against terra at `high` split one game each, and DeepSeek answered wrongly far more often at that level without losing more games.
- Terra at `max` against DeepSeek at `max` has no valid evidence, because the clock removed terra's decisions.
- The one usable finding is about the harness rather than the models: a `max` seat with a large context needs more than a 300-second grace, and the harness now says so in its own record.

## Reproduction

The launch records are `/home/onur/scratch/catanarchy-terra-high-vs-ds-high-seed47-launch.json`, `/home/onur/scratch/catanarchy-terra-max-vs-ds-max-seed47-launch.json`, and `/home/onur/scratch/catanarchy-terra-high-vs-ds-max-seed47-launch.json`. Each holds the flags, the levels, the cost estimate, and the authorization.

The harness ran at commit `4bc3ba0`, which holds the thinking-levels config and the two cell configs. The cost figures come from the `usage` block of each decision record, and the resume seams carry the spend of the records a resume drops.
