---
title: "Level and time-window games on seed 47: terra and sol against DeepSeek"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: 2026-09-13
tags: ["agents", "negotiation", "run-report", "thinking-level", "time-budget"]
---

This report covers fourteen games on board seed 47. Two model families, `openai/gpt-5.6-terra` and `openai/gpt-5.6-sol`, play against `huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita` at two thinking levels and two turn windows. Each family plays DeepSeek in swapped seats, so each model holds each of the four seats once.

The set exists to answer one question: is a level or window comparison against DeepSeek fair to a slower model? The answer changed during the set, because the games found a hidden time limit. A turn holds two time pools, and the second one is small. Raising the turn window did not help. Raising the finalization grace to 300 s removed every empty-pool failure in the set.

DeepSeek won most of the completed games. Terra won two games and led its `high` pair on points, 37 to 31. Sol won three of its four games and lost the fourth.

Two games for one cell are a behavioural case study. They are not a strength verdict. About 85 games are needed to detect a win-rate shift from 50% to 65%.

## Run identity

The run IDs name the model family, the thinking level, and the turn window in minutes. `g300` marks the runs that used a 300-second finalization grace, and every other run used the 60-second default.

| Run                         | Level  | Turn window | Grace | Status    | Turns | Decisions |     Cost | Active time |
| --------------------------- | ------ | ----------: | ----: | --------- | ----: | --------: | -------: | ----------: |
| `terra-high10-seed47-a`     | `high` |        10 m |  60 s | Completed |    95 |       773 | $12.4802 |     111.7 m |
| `terra-high10-seed47-b`     | `high` |        10 m |  60 s | Completed |    95 |       788 | $13.1026 |     103.7 m |
| `terra-max30-seed47-a`      | `max`  |        30 m |  60 s | Completed |    88 |       738 | $14.7280 |     253.5 m |
| `terra-max30-seed47-b`      | `max`  |        30 m |  60 s | Partial   |    76 |       658 | $12.9164 |     253.7 m |
| `terra-max30-g300-seed47-a` | `max`  |        30 m | 300 s | Completed |    59 |       488 | $10.2527 |     123.0 m |
| `terra-max30-g300-seed47-b` | `max`  |        30 m | 300 s | Partial   |    72 |       561 | $13.1936 |     204.9 m |
| `sol-high10-seed47-a`       | `high` |        10 m |  60 s | Partial   |    53 |       413 | $11.2071 |      74.9 m |
| `sol-high10-seed47-b`       | `high` |        10 m |  60 s | Partial   |    52 |       410 | $11.6985 |      75.0 m |
| `sol-max30-seed47-a`        | `max`  |        30 m |  60 s | Partial   |    40 |       324 | $10.2411 |      74.5 m |
| `sol-max30-seed47-b`        | `max`  |        30 m |  60 s | Partial   |    48 |       371 | $11.2931 |      74.1 m |
| `sol-high10-g300-seed47-a`  | `high` |        10 m | 300 s | Completed |    78 |       646 | $21.1013 |     118.1 m |
| `sol-high10-g300-seed47-b`  | `high` |        10 m | 300 s | Completed |    67 |       545 | $16.0662 |      93.8 m |
| `sol-max30-g300-seed47-a`   | `max`  |        30 m | 300 s | Completed |    67 |       532 | $17.5278 |     118.9 m |
| `sol-max30-g300-seed47-b`   | `max`  |        30 m | 300 s | Completed |    79 |       633 | $23.0266 |     147.6 m |

The four `sol-*-seed47-a/b` runs are partial because the operator stopped them to restart the same cells with the 300-second grace. Their packages are kept as labelled partial runs, and they carry the evidence for the grace comparison.

`terra-max30-seed47-b` and `terra-max30-g300-seed47-b` are partial for the same reason. `terra-max30-seed47-b` was stopped for the restart. `terra-max30-g300-seed47-b` was still running when this report was written, so its package holds a frozen snapshot of turn 72.

Every run used seed 47, four seats, one negotiation round, eight planning steps, a 131,072-token context window, and a decision bound of 900 or 2000. No run reached its decision bound. No run reached its cost ceiling, which was $250 for the terra runs and $420 for the sol runs.

## Result

Terra won one game in the 10-minute `high` cell and one game in the 30-minute `max` cell at the 60-second grace. DeepSeek won the rest of the terra games. Sol won both of its `high` games, both at the 300-second grace, and one of its two `max` games.

| Run                         | Winner            | terra | DeepSeek | sol | DeepSeek |
| --------------------------- | ----------------- | ----: | -------: | --: | -------: |
| `terra-high10-seed47-a`     | Orange (DeepSeek) |    18 |       15 |     |          |
| `terra-high10-seed47-b`     | Orange (terra)    |    19 |       16 |     |          |
| `terra-max30-seed47-a`      | Red (terra)       |    18 |       17 |     |          |
| `terra-max30-seed47-b`      | partial game      |    16 |       17 |     |          |
| `terra-max30-g300-seed47-a` | Orange (DeepSeek) |    15 |       17 |     |          |
| `terra-max30-g300-seed47-b` | partial game      |    17 |       14 |     |          |
| `sol-high10-seed47-a`       | partial game      |       |       10 |  13 |          |
| `sol-high10-seed47-b`       | partial game      |       |       14 |   9 |          |
| `sol-max30-seed47-a`        | partial game      |       |       10 |  12 |          |
| `sol-max30-seed47-b`        | partial game      |       |       11 |  12 |          |
| `sol-high10-g300-seed47-a`  | White (sol)       |       |       16 |  18 |          |
| `sol-high10-g300-seed47-b`  | Orange (sol)      |       |       15 |  18 |          |
| `sol-max30-g300-seed47-a`   | Orange (DeepSeek) |       |       18 |   9 |          |
| `sol-max30-g300-seed47-b`   | Orange (sol)      |       |       13 |  18 |          |

Points are effective victory points: owned settlements, cities at two points, the two awards at two points each, and visible victory-point cards. The `sol-max30-g300-seed47-a` game is the clearest loss in the set. Sol's two seats reached 5 and 4 points against DeepSeek's 8 and 10.

Across all sixteen head-to-head games on seed 47, DeepSeek has now won 11, terra 2, and sol 3.

## The finalization grace removed decisions

This is the main finding of the set, and it changed the plan in the middle of it.

A turn key holds two time pools in the Pi adapter. The exploration pool is the turn window, which was 10 or 30 minutes. The finalization pool is the grace period, which was 60 seconds at first. Both pools start again when the turn key changes, and the game and negotiation decisions of one turn share the key, so they share both pools.

When the exploration pool ends, inspection is disabled and the model gets a finalization prompt that asks for one selection. Prose instead of a tool call consumes the finalization pool, and the harness re-prompts inside it. When that pool is empty, the decision path returns an empty response with no model request and no tokens, and the attempt fails at once. The harness then plays the first legal action.

| Run                         | Turn window | Grace | Empty exploration | Empty finalization | No legal action |
| --------------------------- | ----------: | ----: | ----------------: | -----------------: | --------------: |
| `terra-max30-seed47-a`      |        30 m |  60 s |                 0 |                 18 |              21 |
| `terra-max30-seed47-b`      |        30 m |  60 s |                 0 |                 23 |              22 |
| `terra-high10-seed47-a`     |        10 m |  60 s |                 0 |                  0 |               3 |
| `terra-high10-seed47-b`     |        10 m |  60 s |                 0 |                  1 |               4 |
| `terra-max30-g300-seed47-a` |        30 m | 300 s |                 0 |                  0 |              13 |
| `terra-max30-g300-seed47-b` |        30 m | 300 s |                 0 |                  0 |               5 |
| `sol-high10-seed47-a`       |        10 m |  60 s |                 0 |                  0 |               7 |
| `sol-high10-seed47-b`       |        10 m |  60 s |                 0 |                  0 |               4 |
| `sol-max30-seed47-a`        |        30 m |  60 s |                 0 |                  0 |               7 |
| `sol-max30-seed47-b`        |        30 m |  60 s |                 0 |                  0 |               6 |
| `sol-high10-g300-seed47-a`  |        10 m | 300 s |                 0 |                  0 |               8 |
| `sol-high10-g300-seed47-b`  |        10 m | 300 s |                 0 |                  0 |               7 |
| `sol-max30-g300-seed47-a`   |        30 m | 300 s |                 0 |                  0 |               7 |
| `sol-max30-g300-seed47-b`   |        30 m | 300 s |                 0 |                  0 |               6 |

The table separates the two failure kinds. An empty pool means the attempt reached no model and spent no tokens, so the harness replaced the decision. A no-legal-action failure means the model answered, spent tokens, and produced nothing usable, which is the model's own error.

Three facts stand out.

The finalization pool was the cause, not the turn window. Every empty failure in the terra `max` games came from the finalization pool. The two 30-minute games at the 60-second grace produced 18 and 23 of them, more than the 10-minute game at the same grace. The window was six times larger and the failures did not drop.

A 300-second grace removed all of them. Both terra `max` games and all four sol games recorded zero empty attempts on both pools. Sol recorded zero at every grace, so the smaller pool never affected it. One single empty finalization attempt remains in the terra `high` pair, in game B, at the 60-second grace.

The remaining failures are steady. Every game has between 3 and 22 no-legal-action failures, on both seat sets. They cost one decision each, they spread over the game instead of clustering in one turn, and the rate is similar for both models. This is the normal cost of a strict selection tool.

An earlier report, `docs/2026-09-12-terra-seed-47.md`, named the turn window as the cause. That report is corrected. The harness now records the agent error text in the `failureMessage` field of a failed decision and of the fallback that follows it, so the two kinds are separated in the record itself. Before that change the split came from the recorded clocks, which is how the table above was built.

One cell kept the 60-second grace. The terra `high` pair lost one decision to the empty finalization pool and none to the empty exploration pool, out of 788 and 773 decisions, so the operator did not repeat it. Every other cell that showed an empty-pool loss was repeated at the 300-second grace. This is the one asymmetry in the set.

## Cost

| Run                         |     Cost | Per turn | Per minute | terra/sol | DeepSeek |
| --------------------------- | -------: | -------: | ---------: | --------: | -------: |
| `terra-high10-seed47-a`     | $12.4802 |   $0.131 |     $0.112 |  $10.3653 |  $2.1149 |
| `terra-high10-seed47-b`     | $13.1026 |   $0.138 |     $0.126 |  $11.2787 |  $1.8239 |
| `terra-max30-seed47-a`      | $14.7280 |   $0.167 |     $0.058 |  $13.1898 |  $1.5382 |
| `terra-max30-seed47-b`      | $12.9164 |   $0.170 |     $0.051 |  $11.2402 |  $1.6762 |
| `terra-max30-g300-seed47-a` | $10.2527 |   $0.174 |     $0.083 |   $8.8448 |  $1.4079 |
| `terra-max30-g300-seed47-b` | $13.1936 |   $0.183 |     $0.064 |  $11.8529 |  $1.3407 |
| `sol-high10-seed47-a`       | $11.2071 |   $0.211 |     $0.150 |  $10.0698 |  $1.1373 |
| `sol-high10-seed47-b`       | $11.6985 |   $0.225 |     $0.156 |  $10.6163 |  $1.0822 |
| `sol-max30-seed47-a`        | $10.2411 |   $0.256 |     $0.137 |   $9.4086 |  $0.8324 |
| `sol-max30-seed47-b`        | $11.2931 |   $0.235 |     $0.152 |  $10.5151 |  $0.7779 |
| `sol-high10-g300-seed47-a`  | $21.1013 |   $0.271 |     $0.179 |  $19.5073 |  $1.5940 |
| `sol-high10-g300-seed47-b`  | $16.0662 |   $0.240 |     $0.171 |  $14.6535 |  $1.4128 |
| `sol-max30-g300-seed47-a`   | $17.5278 |   $0.262 |     $0.147 |  $16.0242 |  $1.5036 |
| `sol-max30-g300-seed47-b`   | $23.0266 |   $0.291 |     $0.156 |  $21.3584 |  $1.6683 |

The fourteen runs cost $198.8351 together. The DeepSeek seats cost $0.78 to $2.11 per game in every cell, so the difference between cells is the challenger's cost.

Sol costs more than terra at the same level. Sol's `high` games cost $0.24 to $0.27 per turn against terra's $0.13 per turn. Sol also spends more per goal: it won three games on $14.7, $19.5, and $21.4 of its own model cost.

The 300-second grace raised the cost of the sol cells, because longer thinking now reaches more decisions. `sol-high10-g300-seed47-a` cost $21.10 against $11.21 for the stopped 60-second game at the same level and window, and it played 78 turns instead of 53.

Costs are the recorded per-request usage from the run timeline, which is the same basis as the earlier seed 47 reports. No resume seam exists in these runs, so the timeline sum is the whole cost.

## Thinking level: high against max

`max` costs two to four times more per decision than `high` for both families, and it does not win more games.

| Cell               | Level  | Games | Wins |     Cost | Cost per turn | Empty pools |  Median decision |
| ------------------ | ------ | ----: | ---: | -------: | ------------: | ----------: | ---------------: |
| `terra-high10`     | `high` |     2 |    1 | $25.5828 |        $0.134 |           1 | 2,921 / 2,955 ms |
| `terra-max30`      | `max`  |     2 |    1 | $27.6444 |        $0.168 |          41 | 6,184 / 5,168 ms |
| `terra-max30-g300` | `max`  |     2 |    0 | $23.4462 |        $0.179 |           0 | 5,257 / 4,426 ms |
| `sol-high10-g300`  | `high` |     2 |    2 | $37.1675 |        $0.256 |           0 | 5,377 / 5,377 ms |
| `sol-max30-g300`   | `max`  |     2 |    1 | $40.5544 |        $0.277 |           0 | 8,661 / 8,017 ms |

Terra's decisions at `max` take about twice as long as its decisions at `high`, and its output per call rises from 211 to 864 tokens. That is why the smaller pool broke the terra `max` games first. Terra's `high` pair is the only terra cell where both games finished, and it is also the only terra cell where terra beat DeepSeek on points, 37 to 31.

Sol is the slower model in both cells. Its median decision takes 5,377 ms at `high` and 8,017 to 8,661 ms at `max`. Raising its level from `high` to `max` cost 9 percent more per turn and won one game fewer, two against one.

## Play observations

Negotiation worked in every game. Each game closed 5 to 14 accepted trades out of 37 to 72 offers, with 81 to 254 passes. Both models made offers in every game.

Robber moves, development cards, and maritime trades all appear in every game. Each game recorded 5 to 27 robber moves and 41 to 96 dice rolls, and the sevens and eights behaved as the probabilities predict.

Two games show how close the cells are. `terra-max30-seed47-a` ended 18 to 17 with terra winning on its own turn, and `terra-max30-g300-seed47-b` stood at 17 to 14 for terra when the report was written. The sol games swing more: 36 to 31 toward sol in the `high` cell, and 27 to 31 toward DeepSeek in the `max` cell.

## Reproduction

The eight games that carry the corrected grace ran from `/home/onur/repos/catanarchy` with these commands, one per run:

```sh
npx tsx apps/pi-cli/src/index.ts \
  --models=openai/gpt-5.6-terra,huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita \
  --run-id=terra-max30-g300-seed47-a --run-dir=/home/onur/scratch/catanarchy-terra-max30-g300-seed47-a \
  --seed=47 --decisions=2000 --cost-ceiling-usd=250 --thinking=max \
  --turn-time-ms=1800000 --finalization-grace-ms=300000 \
  --models-path=/home/onur/.pi/agent/models.json --context-window-tokens=131072 \
  --negotiation-rounds=1 --max-planning-steps=8
```

Swap the run ID, the run directory, the models, and the two time values for the other cells. The sol cells use `--models=openai/gpt-5.6-sol,huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita` and a $420 ceiling. The store at `/home/onur/.cache/catanarchy/models-store.json` maps DeepSeek `max` to `high`, because DeepSeek at `max` spends 28,110 tokens and 120 seconds on a single setup decision.

## Limits

- Two games per cell. The winners and the points are case studies, not rates.
- The DeepSeek seats kept thinking level `high` in every game so that one variable changed at a time.
- The terra `max` cell at the 60-second grace is not a fair measure of terra at that level. Its result is a lower bound, because the harness replaced 18 and 23 of its decisions.
- The four sol partial runs and two terra partial runs stop mid-game, so they have no winner.
- `terra-max30-seed47-b` and `terra-max30-g300-seed47-b` were still running or stopped early, so their point totals are not final.
- The trace records the agent error text only from this change forward. The split in the grace table comes from the recorded clocks of the earlier runs.
- The harness default for the finalization grace is still 60 seconds. The runs here set it explicitly.

## Published location

The fourteen run packages are published in the public bucket `osolmaz/catanarchy-runs`, under `runs/<run-id>`. Each package holds the manifest, the timeline, the four seat sessions, the decision analysis, the launch record, a copy of this report as `REPORT.md`, and `CHECKSUMS.sha256`. Every file in every package verifies against its checksum from the public URL.

Thirteen packages hold a finished or stopped run. The package for `terra-max30-g300-seed47-b` holds a frozen copy of turn 72, because that run was still writing when the package was built. A live run changes its timeline and its session files, so a package built directly from it cannot verify. The final package replaces the snapshot when the run ends.

## Related documents

- `docs/2026-09-11-deepseek-v4-1-flash-seed-47.md`: the four-seat DeepSeek baseline on the same seed.
- `docs/2026-09-12-mixed-seat-seed-47-pair.md`: the Luna pair and the resume feature.
- `docs/2026-09-12-terra-seed-47.md`: the terra pair at `max`, with the corrected time-pool finding.
- `docs/AGENT_HARNESS.md`: the two time pools and the failure path.
- `docs/RUN_LOG.md`: the record kinds and the `failureMessage` field.
