---
title: "Level and time-window games on seed 47: terra and sol against DeepSeek"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: 2026-09-13
tags: ["agents", "negotiation", "run-report", "thinking-level", "time-budget"]
---

This report covers sixteen games on board seed 47. Two model families, `openai/gpt-5.6-terra` and `openai/gpt-5.6-sol`, play against `huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita` at two thinking levels and two turn windows. Each family plays DeepSeek in swapped seats, so each model holds each of the four seats once.

The set exists to answer one question: is a level or window comparison against DeepSeek fair to a slower model? The answer changed during the set, because the games found a hidden time limit. A turn holds two time pools, and the second one is small. Raising the turn window did not help, and a larger grace helped only in part, because one turn key shared one grace pool. Two fresh games under a harness that gives every decision its own grace, and that replaces a decision with a neutral action, recorded no empty-pool failure at all.

DeepSeek won most of the decided games. Terra won four games, and it led DeepSeek on points in three of its four cells. Sol won three of its four decided games.

Two games for one cell are a behavioural case study. They are not a strength verdict. About 85 games are needed to detect a win-rate shift from 50% to 65%.

## Run identity

The run IDs name the model family, the thinking level, and the turn window in minutes. `g300` marks the runs that asked for a 300-second finalization grace, and every other run used the 60-second default of that time. `fixed` marks the two games that ran on the harness with a per-decision grace of 300 seconds and a neutral replacement for a lost decision; the harness default is now the same 300 seconds for every run.

| Run                          | Level  | Turn window | Grace | Status    | Turns | Decisions |     Cost | Active time |
| ---------------------------- | ------ | ----------: | ----: | --------- | ----: | --------: | -------: | ----------: |
| `terra-high10-seed47-a`      | `high` |        10 m |  60 s | Completed |    95 |       773 | $12.4802 |     111.7 m |
| `terra-high10-seed47-b`      | `high` |        10 m |  60 s | Completed |    95 |       788 | $13.1026 |     103.7 m |
| `terra-max30-seed47-a`       | `max`  |        30 m |  60 s | Completed |    88 |       738 | $14.7280 |     253.5 m |
| `terra-max30-seed47-b`       | `max`  |        30 m |  60 s | Partial   |    76 |       658 | $12.9164 |     253.7 m |
| `terra-max30-g300-seed47-a`  | `max`  |        30 m | 300 s | Completed |    59 |       488 | $10.2527 |     123.0 m |
| `terra-max30-g300-seed47-b`  | `max`  |        30 m | 300 s | Completed |    89 |       755 | $16.2961 |     464.7 m |
| `terra-max30-fixed-seed47-a` | `max`  |        30 m | 300 s | Completed |    85 |       700 | $16.0692 |     252.5 m |
| `terra-max30-fixed-seed47-b` | `max`  |        30 m | 300 s | Completed |    59 |       477 | $10.6637 |     123.4 m |
| `sol-high10-seed47-a`        | `high` |        10 m |  60 s | Partial   |    53 |       413 | $11.2071 |      74.9 m |
| `sol-high10-seed47-b`        | `high` |        10 m |  60 s | Partial   |    52 |       410 | $11.6985 |      75.0 m |
| `sol-max30-seed47-a`         | `max`  |        30 m |  60 s | Partial   |    40 |       324 | $10.2411 |      74.5 m |
| `sol-max30-seed47-b`         | `max`  |        30 m |  60 s | Partial   |    48 |       371 | $11.2931 |      74.1 m |
| `sol-high10-g300-seed47-a`   | `high` |        10 m | 300 s | Completed |    78 |       646 | $21.1013 |     118.1 m |
| `sol-high10-g300-seed47-b`   | `high` |        10 m | 300 s | Completed |    67 |       545 | $16.0662 |      93.8 m |
| `sol-max30-g300-seed47-a`    | `max`  |        30 m | 300 s | Completed |    67 |       532 | $17.5278 |     118.9 m |
| `sol-max30-g300-seed47-b`    | `max`  |        30 m | 300 s | Completed |    79 |       633 | $23.0266 |     147.6 m |

The four `sol-*-seed47-a/b` runs are partial because the operator stopped them to restart the same cells with the 300-second grace. Their packages are kept as labelled partial runs, and they carry the evidence for the grace comparison.

`terra-max30-seed47-b` is the one terra partial run, and the operator stopped it for the restart. `terra-max30-g300-seed47-b` ran to the end after the report was first written, so its package holds the whole game.

Every run used seed 47, four seats, one negotiation round, eight planning steps, a 131,072-token context window, and a decision bound of 900 or 2000. No run reached its decision bound. No run reached its cost ceiling, which was $250 for the terra runs and $420 for the sol runs.

## Result

Terra won one game in the 10-minute `high` cell, one game in the 30-minute `max` cell at the 60-second grace, one in each of the two `max` cells at the 300-second grace, and one of the two fresh games at the fixed harness. DeepSeek won the rest of the terra games. Sol won both of its `high` games, both at the 300-second grace, and one of its two `max` games.

| Run                          | Winner            | terra | DeepSeek | sol | DeepSeek |
| ---------------------------- | ----------------- | ----: | -------: | --: | -------: |
| `terra-high10-seed47-a`      | Orange (DeepSeek) |    18 |       15 |     |          |
| `terra-high10-seed47-b`      | Orange (terra)    |    19 |       16 |     |          |
| `terra-max30-seed47-a`       | Red (terra)       |    18 |       17 |     |          |
| `terra-max30-seed47-b`       | partial game      |    16 |       17 |     |          |
| `terra-max30-g300-seed47-a`  | Orange (DeepSeek) |    15 |       17 |     |          |
| `terra-max30-g300-seed47-b`  | Blue (terra)      |    19 |       15 |     |          |
| `terra-max30-fixed-seed47-a` | Blue (DeepSeek)   |    18 |       17 |     |          |
| `terra-max30-fixed-seed47-b` | Orange (terra)    |    18 |        9 |     |          |
| `sol-high10-seed47-a`        | partial game      |       |       10 |  13 |          |
| `sol-high10-seed47-b`        | partial game      |       |       14 |   9 |          |
| `sol-max30-seed47-a`         | partial game      |       |       10 |  12 |          |
| `sol-max30-seed47-b`         | partial game      |       |       11 |  12 |          |
| `sol-high10-g300-seed47-a`   | White (sol)       |       |       16 |  18 |          |
| `sol-high10-g300-seed47-b`   | Orange (sol)      |       |       15 |  18 |          |
| `sol-max30-g300-seed47-a`    | Orange (DeepSeek) |       |       18 |   9 |          |
| `sol-max30-g300-seed47-b`    | Orange (sol)      |       |       13 |  18 |          |

Points are effective victory points: owned settlements, cities at two points, the two awards at two points each, and visible victory-point cards. The `sol-max30-g300-seed47-a` game is the clearest loss in the set. Sol's two seats reached 5 and 4 points against DeepSeek's 8 and 10.

Eleven of the sixteen games in this set are decided: DeepSeek won four, terra four, and sol three. Seventeen head-to-head games on seed 47 have finished: DeepSeek ten, terra four, and sol three. The series also holds four Luna games, which DeepSeek won, and one four-seat DeepSeek baseline game with no challenger.

## The finalization grace removed decisions

This is the main finding of the set, and it changed the plan in the middle of it.

A turn key holds two time pools in the Pi adapter. The exploration pool is the turn window, which was 10 or 30 minutes. The finalization pool is the grace period, which was 60 seconds at first. Both pools start again when the turn key changes, and the game and negotiation decisions of one turn share the key, so they share both pools. A later harness change gives each decision its own finalization pool and leaves the exploration pool with the turn key.

When the exploration pool ends, inspection is disabled and the model gets a finalization prompt that asks for one selection. Prose instead of a tool call consumes the finalization pool, and the harness re-prompts inside it. When that pool is empty, the decision path returns an empty response with no model request and no tokens, and the attempt fails at once. The harness then replaces the decision. Before the fix it played the first legal action, which spends when a build, a trade, or a development card comes before `end-turn`. It now takes a neutral action where the rules allow one: it ends the turn, it rolls when the roll is owed, or it moves the robber. A forced phase picks with a hash of the decision identity, so a replacement carries no board information and does not favour one action.

| Run                          | Turn window | Grace | Empty exploration | Empty finalization | No legal action |
| ---------------------------- | ----------: | ----: | ----------------: | -----------------: | --------------: |
| `terra-max30-seed47-a`       |        30 m |  60 s |                 0 |                 17 |              21 |
| `terra-max30-seed47-b`       |        30 m |  60 s |                 0 |                 22 |              22 |
| `terra-high10-seed47-a`      |        10 m |  60 s |                 0 |                  0 |               3 |
| `terra-high10-seed47-b`      |        10 m |  60 s |                 0 |                  1 |               4 |
| `terra-max30-g300-seed47-a`  |        30 m | 300 s |                 0 |                  0 |              13 |
| `terra-max30-g300-seed47-b`  |        30 m | 300 s |                 0 |                 14 |              36 |
| `terra-max30-fixed-seed47-a` |        30 m | 300 s |                 0 |                  0 |              10 |
| `terra-max30-fixed-seed47-b` |        30 m | 300 s |                 0 |                  0 |              10 |
| `sol-high10-seed47-a`        |        10 m |  60 s |                 0 |                  0 |               7 |
| `sol-high10-seed47-b`        |        10 m |  60 s |                 0 |                  0 |               4 |
| `sol-max30-seed47-a`         |        30 m |  60 s |                 0 |                  0 |               7 |
| `sol-max30-seed47-b`         |        30 m |  60 s |                 0 |                  0 |               6 |
| `sol-high10-g300-seed47-a`   |        10 m | 300 s |                 0 |                  0 |               8 |
| `sol-high10-g300-seed47-b`   |        10 m | 300 s |                 0 |                  0 |               7 |
| `sol-max30-g300-seed47-a`    |        30 m | 300 s |                 0 |                  0 |               7 |
| `sol-max30-g300-seed47-b`    |        30 m | 300 s |                 0 |                  0 |               6 |

Two kinds of evidence stand behind the empty-pool column. The runs from the `fixed` pair forward record the pool and the remaining time on a failed attempt, so an empty pool is a recorded fact there. The earlier runs carry no such field, and the count there comes from the recorded clock and the token usage: an attempt that returns in under 2 ms and spends no output tokens certainly made no model request. The two terra `max` games at the 60-second grace hold 17 and 22 of those, and one further attempt in each game spent no tokens after more than 2 ms. Those two attempts stay unclassified, and the session files hold no error entry for them.

The table separates the two failure kinds. An empty pool means the attempt reached no model and spent no tokens, so the harness replaced the decision. A no-legal-action failure means the model answered, spent tokens, and produced nothing usable, which is the model's own error.

Five facts stand out.

The finalization pool was the cause, not the turn window. Every empty failure in the terra `max` games came from the finalization pool. The two 30-minute games at the 60-second grace produced 17 and 22 of them, more than the 10-minute game at the same grace. The window was six times larger and the failures did not drop.

A 300-second grace helped only in part. All four sol games and the first terra `max` game at that grace recorded zero empty attempts. The second terra `max` game at the same grace still lost 14 decisions, 10 of them board decisions, because one turn key shared one grace pool: an earlier decision of the turn spent the pool, and the later decisions of that same turn reached no model at all.

The per-decision grace removed all trace of the defect. The two fresh games recorded zero empty attempts on both pools, out of 700 and 477 decisions. The harness default is now 300 seconds for each decision, so the shared pool that caused this does not exist in a new run.

A third failure kind appeared in the fresh games. Five attempts spent no tokens, took about a second, and ended with `Request timed out.` in the session file. No pool was empty, because each of those attempts had almost the whole grace left when it failed. Game A had two of them, both negotiation decisions; game B had two negotiation decisions and one board decision.

The remaining failures are steady. Every game has between 3 and 36 no-legal-action failures, on both seat sets. They cost one decision each, they spread over the game instead of clustering in one turn, and the rate is similar for both models. This is the normal cost of a strict selection tool.

An earlier report, `docs/2026-09-12-terra-seed-47.md`, named the turn window as the cause. That report is corrected. The harness now records the agent error text in the `failureMessage` field of a failed decision and of the fallback that follows it, so the two kinds are separated in the record itself. Before that change the split came from the recorded clocks, which is how the table above was built.

One cell kept the 60-second grace. The terra `high` pair lost one negotiation decision to the empty finalization pool and none to the empty exploration pool, out of 788 and 773 decisions, so the operator did not repeat it. No board decision in that pair was lost to the clock. Every other cell that showed an empty-pool loss was repeated at the 300-second grace, and the terra `max` cell was repeated once more under the per-decision grace. This is the one asymmetry in the set.

## Cost

| Run                          |     Cost | Per turn | Per minute | terra/sol | DeepSeek |
| ---------------------------- | -------: | -------: | ---------: | --------: | -------: |
| `terra-high10-seed47-a`      | $12.4802 |   $0.131 |     $0.112 |  $10.3653 |  $2.1149 |
| `terra-high10-seed47-b`      | $13.1026 |   $0.138 |     $0.126 |  $11.2787 |  $1.8239 |
| `terra-max30-seed47-a`       | $14.7280 |   $0.167 |     $0.058 |  $13.1898 |  $1.5382 |
| `terra-max30-seed47-b`       | $12.9164 |   $0.170 |     $0.051 |  $11.2402 |  $1.6762 |
| `terra-max30-g300-seed47-a`  | $10.2527 |   $0.174 |     $0.083 |   $8.8448 |  $1.4079 |
| `terra-max30-g300-seed47-b`  | $16.2961 |   $0.183 |     $0.035 |  $14.6721 |  $1.6240 |
| `terra-max30-fixed-seed47-a` | $16.0692 |   $0.189 |     $0.064 |  $14.5307 |  $1.5386 |
| `terra-max30-fixed-seed47-b` | $10.6637 |   $0.181 |     $0.086 |   $9.7109 |  $0.9528 |
| `sol-high10-seed47-a`        | $11.2071 |   $0.211 |     $0.150 |  $10.0698 |  $1.1373 |
| `sol-high10-seed47-b`        | $11.6985 |   $0.225 |     $0.156 |  $10.6163 |  $1.0822 |
| `sol-max30-seed47-a`         | $10.2411 |   $0.256 |     $0.137 |   $9.4086 |  $0.8324 |
| `sol-max30-seed47-b`         | $11.2931 |   $0.235 |     $0.152 |  $10.5151 |  $0.7779 |
| `sol-high10-g300-seed47-a`   | $21.1013 |   $0.271 |     $0.179 |  $19.5073 |  $1.5940 |
| `sol-high10-g300-seed47-b`   | $16.0662 |   $0.240 |     $0.171 |  $14.6535 |  $1.4128 |
| `sol-max30-g300-seed47-a`    | $17.5278 |   $0.262 |     $0.147 |  $16.0242 |  $1.5036 |
| `sol-max30-g300-seed47-b`    | $23.0266 |   $0.291 |     $0.156 |  $21.3584 |  $1.6683 |

The sixteen runs cost $228.6705 together, and the two fresh games on the fixed harness cost $26.7329 of that. The DeepSeek seats cost $0.78 to $2.11 per game in every cell, so the difference between cells is the challenger's cost.

Sol costs more than terra at the same level. Sol's `high` games cost $0.24 to $0.27 per turn against terra's $0.13 per turn. Sol also spends more per goal: it won three games on $14.7, $19.5, and $21.4 of its own model cost.

The 300-second grace raised the cost of the sol cells, because longer thinking now reaches more decisions. `sol-high10-g300-seed47-a` cost $21.10 against $11.21 for the stopped 60-second game at the same level and window, and it played 78 turns instead of 53.

Costs are the recorded per-request usage from the run timeline, which is the same basis as the earlier seed 47 reports. No resume seam exists in these runs, so the timeline sum is the whole cost.

## Thinking level: high against max

`max` costs two to four times more per decision than `high` for both families, and it does not win more games.

| Cell                | Level  | Games | Wins |     Cost | Cost per turn | Empty pools |  Median decision |
| ------------------- | ------ | ----: | ---: | -------: | ------------: | ----------: | ---------------: |
| `terra-high10`      | `high` |     2 |    1 | $25.5828 |        $0.134 |           1 | 2,912 / 2,950 ms |
| `terra-max30`       | `max`  |     2 |    1 | $27.6444 |        $0.168 |          41 | 4,617 / 3,788 ms |
| `terra-max30-g300`  | `max`  |     2 |    1 | $26.5488 |        $0.179 |          14 | 5,235 / 4,073 ms |
| `terra-max30-fixed` | `max`  |     2 |    1 | $26.7329 |        $0.186 |           0 | 4,443 / 3,765 ms |
| `sol-high10-g300`   | `high` |     2 |    2 | $37.1675 |        $0.256 |           0 | 5,322 / 5,369 ms |
| `sol-max30-g300`    | `max`  |     2 |    1 | $40.5544 |        $0.277 |           0 | 8,616 / 7,951 ms |

The last column gives the median decision time of the challenger over all of its decisions, game and negotiation together, for game A and then game B.

Terra's median decision time at `max` is one and a half times its time at `high`, and its output per call rises from 211 to 864 tokens. That is why the smaller pool broke the terra `max` games first. Three terra cells now hold two finished games: the `high` pair, the 300-second `max` cell, and the fixed `max` cell. Terra led DeepSeek on points in all three.

Sol is the slower model in both cells. Its median decision takes 5,322 to 5,369 ms at `high` and 7,951 to 8,616 ms at `max`. Raising its level from `high` to `max` cost 9 percent more per turn and won one game fewer, two against one.

## Play observations

Negotiation worked in every game. Each game closed 5 to 14 accepted trades out of 37 to 72 offers, with 81 to 254 passes. Both models made offers in every game.

Robber moves, development cards, and maritime trades all appear in every game. Each game recorded 5 to 27 robber moves and 41 to 96 dice rolls, and the sevens and eights behaved as the probabilities predict.

Two games show how close the cells are. `terra-max30-seed47-a` ended 18 to 17 with terra winning on its own turn, and `terra-max30-g300-seed47-b` stood at 17 to 14 for terra when the report was written. The sol games swing more: 36 to 31 toward sol in the `high` cell, and 27 to 31 toward DeepSeek in the `max` cell.

## Reproduction

The eight games that set the 300-second grace explicitly ran from `/home/onur/repos/catanarchy` with this command, one per run. The two fresh `fixed` games used the same command with no `--finalization-grace-ms` flag, because the value under test is the new default of 300 seconds for each decision.

```sh
npx tsx apps/pi-cli/src/index.ts \
  --models=openai/gpt-5.6-terra,huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita \
  --run-id=terra-max30-g300-seed47-a --run-dir=/home/onur/scratch/catanarchy-terra-max30-g300-seed47-a \
  --seed=47 --decisions=2000 --cost-ceiling-usd=250 --thinking=max \
  --turn-time-ms=1800000 --finalization-grace-ms=300000 \
  --models-path=/home/onur/.pi/agent/models.json --context-window-tokens=131072 \
  --negotiation-rounds=1 --max-planning-steps=8
```

Swap the run ID, the run directory, the models, and the two time values for the other cells. The sol cells use `--models=openai/gpt-5.6-sol,huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita` and a $420 ceiling. The store at `/home/onur/.cache/catanarchy/models-store.json` maps DeepSeek `max` to `high`, so a `--thinking=max` run raises the challenger only. The 28,110-token figure given here earlier came from one sample and is an outlier; see [Thinking levels](THINKING_LEVELS.md). A ceiling must exceed the worst-case cost of one request, or the harness refuses the run before the first model call; that request is $212.16 for a terra seat and $378.25 for a sol seat, so the effective stop is the ceiling minus that value.

## Limits

- Two games per cell. The winners and the points are case studies, not rates.
- The DeepSeek seats kept thinking level `high` in every game so that one variable changed at a time.
- The terra `max` cell at the 60-second grace is not a fair measure of terra at that level. Its result is a lower bound, because the harness replaced 17 and 22 of its decisions, 9 and 12 of them board decisions.
- The four sol partial runs and one terra partial run stop mid-game, so they have no winner.
- Only `terra-max30-seed47-b` is unfinished. The other fifteen games hold a winner, so their point totals are final.
- The trace records the agent error text in the `failureMessage` field only from that change forward, which is why the two fresh games carry it and the earlier ones do not. The split in the grace table comes from the recorded clocks and, for the fresh games, from the recorded `pool` and `remainingMs` fields directly.
- The harness default for the finalization grace was 60 seconds when the first runs were made, and those runs set the value explicitly. The numbers here stand as measured. The default is now 300 seconds for each decision, and a replaced decision takes a neutral action where the rules allow one.

## Published location

The sixteen run packages are published in the public bucket `osolmaz/catanarchy-runs`, under `runs/<run-id>`. Each package holds the manifest, the timeline, the four seat sessions, the decision analysis, the launch record, a copy of this report as `REPORT.md`, and `CHECKSUMS.sha256`. Every file in every package verifies against its checksum from the public URL.

Fifteen packages hold a finished run and one holds a stopped run. A live run changes its timeline and its session files, so a package built directly from it cannot verify. The package for a run is therefore built from a frozen copy while that run is active, and replaced from the run directory when the run ends. Every package here is either a stopped run or a finished one, so every package verifies.

## Related documents

- `docs/2026-09-11-deepseek-v4-1-flash-seed-47.md`: the four-seat DeepSeek baseline on the same seed.
- `docs/2026-09-12-mixed-seat-seed-47-pair.md`: the Luna pair and the resume feature.
- `docs/2026-09-12-terra-seed-47.md`: the terra pair at `max`, with the corrected time-pool finding.
- `docs/AGENT_HARNESS.md`: the two time pools and the failure path.
- `docs/RUN_LOG.md`: the record kinds and the `failureMessage` field.
