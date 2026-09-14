---
title: Mixed-seat seed 47 paired run report
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-12
tags:
  - agents
  - negotiation
  - run-report
  - resume
---

# Mixed-seat seed 47 paired run report

This report covers two games on board seed 47 with the same two models in swapped seats. One seat set holds `openai/gpt-5.6-luna`. The other holds `huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita`. The pair exists to cancel seat order and board luck between the two games.

Both games stopped early for an unknown reason. Both were then continued with the [resume](RESUME.md) feature. This report records the result, the cost of the whole pair, the cost of the resumed part, and what the resume cost compared with a fresh restart.

Two games on one seed are a behavioural case study. They are not a strength verdict. About 85 games are needed to detect a win-rate shift from 50% to 65%.

A second pair followed with Luna at a higher thinking level. The section [Thinking level: high against xhigh](#thinking-level-high-against-xhigh) records that pair and compares it with this one. A third pair followed with `openai/gpt-5.6-terra` at thinking `max`, recorded in the [Terra seed 47 run report at thinking max](2026-09-12-terra-seed-47.md).

## Run identity

| Field                | Game A                                              | Game B                                              |
| -------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Run ID               | `luna-mixed-seed47-a`                               | `luna-mixed-seed47-b`                               |
| Match ID             | `pi-game-47`                                        | `pi-game-47`                                        |
| Board seed           | 47                                                  | 47                                                  |
| Status               | Completed                                           | Completed                                           |
| Winner               | Orange (DeepSeek)                                   | Red (DeepSeek)                                      |
| Winning turn         | 68                                                  | 69                                                  |
| Started              | 2026-09-11 17:13:29 UTC                             | 2026-09-11 17:13:29 UTC                             |
| Finished             | 2026-09-12 05:41:55 UTC                             | 2026-09-12 05:46:10 UTC                             |
| Resumed              | 2026-09-12 05:11:28 UTC, warm                       | 2026-09-12 05:12:03 UTC, warm                       |
| Pi version           | 0.85.1                                              | 0.85.1                                              |
| Local source package | `/home/onur/scratch/catanarchy-luna-mixed-seed47-a` | `/home/onur/scratch/catanarchy-luna-mixed-seed47-b` |

Seat assignment:

| Seat   | Game A   | Game B   |
| ------ | -------- | -------- |
| Red    | Luna     | DeepSeek |
| Blue   | DeepSeek | Luna     |
| White  | Luna     | DeepSeek |
| Orange | DeepSeek | Luna     |

Both games used one negotiation round per window, thinking level `high`, a 131072-token context window, 8 planning steps, a 600000 ms turn time, a 60000 ms finalization grace, and a per-game cost ceiling of $60. The run packages follow the [run log format](RUN_LOG.md).

Both packages are published in the public Bucket:

| Game   | Package                                                         |
| ------ | --------------------------------------------------------------- |
| Game A | `hf://buckets/osolmaz/catanarchy-runs/runs/luna-mixed-seed47-a` |
| Game B | `hf://buckets/osolmaz/catanarchy-runs/runs/luna-mixed-seed47-b` |

Each package holds `manifest.json`, `timeline.jsonl`, one Pi session per seat, `analysis.json`, `CHECKSUMS.sha256`, and this report as `REPORT.md`. It also holds `launch.json` and `resume.json`, which carry the launch configuration. The manifest does not record that configuration. The credential file paths in those two records are redacted.

## Result

DeepSeek won both games, in both seat sets. Luna won neither.

Game A:

| Player | Model    | Settlements | Cities | Public points | Hidden VP cards | Effective total |
| ------ | -------- | ----------: | -----: | ------------: | --------------: | --------------: |
| Orange | DeepSeek |           4 |      2 |             8 |               0 |          **10** |
| Blue   | DeepSeek |           4 |      1 |             6 |               0 |           **6** |
| Red    | Luna     |           3 |      0 |             3 |               2 |           **5** |
| White  | Luna     |           3 |      0 |             3 |               1 |           **4** |

Orange took Longest Road at length 9 on the last turn. Largest Army was unclaimed, because no seat played three knights.

Game B:

| Player | Model    | Settlements | Cities | Public points | Hidden VP cards | Effective total |
| ------ | -------- | ----------: | -----: | ------------: | --------------: | --------------: |
| Red    | DeepSeek |           3 |      2 |             7 |               1 |          **10** |
| Blue   | Luna     |           4 |      0 |             4 |               1 |           **7** |
| White  | DeepSeek |           3 |      1 |             5 |               1 |           **6** |
| Orange | Luna     |           2 |      0 |             3 |               1 |           **3** |

Red held Largest Army with three knights and took the last two points from it. Blue held Longest Road at length 5.

Across the four DeepSeek seats the effective total was 32. Across the four Luna seats it was 19. The seat swap did not change which model won.

## The stop and the resume

Both games stopped at 2026-09-11 17:56 UTC, about 43 minutes after they started. The stop was not caused by the game:

- Neither manifest records an error, and neither timeline holds a failure record.
- `earlyoom` reported 82% of 124546 MiB free, and the journal holds no kill for either process.
- Both timelines end on a `negotiation.agent-requested` record, so both processes were waiting on a model request at the same moment.
- Both games and their watcher stopped within 66 seconds of each other.

The cause is still unknown. The evidence points to an external teardown of the waiting processes.

Both games were then continued from their own timelines. The resume took the last completed command as its boundary, replayed the prefix, and reopened the four seat sessions of each game.

| Field                      | Game A      | Game B     |
| -------------------------- | ----------- | ---------- |
| Resume record index        | 1517        | 1032       |
| Records dropped by the cut | 2           | 8          |
| Spend carried by the seam  | $0.000000   | $0.002845  |
| Replayed game sequence     | 198         | 140        |
| State verification         | exact       | exact      |
| Resumed segment duration   | 30 min 28 s | 34 min 7 s |
| Stop repeated              | no          | no         |

Both games wrote a terminal record and released the run lock. The resume added one `run.resumed` seam to each timeline. The item that remained untested in the resume verification plan, a real stopped match under `/home/onur/scratch`, is now covered twice.

## Cost

| Segment         |    Game A |    Game B |      Pair |
| --------------- | --------: | --------: | --------: |
| Before the stop | $1.114947 | $1.027334 | $2.142281 |
| Resumed segment | $0.917667 | $1.154279 | $2.071946 |
| Whole run       | $2.032615 | $2.181613 | $4.214228 |

The whole-run figures use the recorded decision records plus the seam. The cost budget, which also counts calls that produced no decision record, reported $2.032615 for game A and $2.189555 for game B, a pair total of $4.222170. Game A agrees exactly. Game B differs by $0.007942, or 0.4%. The gap is spend on calls that were not recorded as decisions.

Cost per unit of work:

| Measure                     | Game A prefix | Game A resumed | Game B prefix | Game B resumed |
| --------------------------- | ------------: | -------------: | ------------: | -------------: |
| Turns                       |            51 |             16 |            35 |             33 |
| Cost per turn               |       $0.0219 |        $0.0574 |       $0.0293 |        $0.0350 |
| Cache-write tokens per turn |         8,666 |         29,646 |         9,790 |         18,024 |

The resumed part was not cheaper per turn. Later turns are heavier, and a resume rebuilds the prompt cache once per seat.

Tokens:

| Measure      |     Game A |     Game B |       Pair |
| ------------ | ---------: | ---------: | ---------: |
| Billed calls |        533 |        532 |      1,065 |
| Input        |  2,680,248 |  2,830,827 |  5,511,075 |
| Output       |    604,566 |    677,607 |  1,282,173 |
| Cache read   | 36,388,374 | 35,719,434 | 72,107,808 |
| Cache write  |    916,280 |    937,442 |  1,853,722 |
| Total tokens | 40,589,468 | 40,165,310 | 80,754,778 |

Cost per seat set:

| Game | Seat set                | Calls |      Cost | Share |
| ---- | ----------------------- | ----: | --------: | ----: |
| A    | Luna (red, white)       |   253 | $0.691216 |   34% |
| A    | DeepSeek (blue, orange) |   289 | $1.341399 |   66% |
| B    | DeepSeek (red, white)   |   273 | $1.424513 |   65% |
| B    | Luna (blue, orange)     |   270 | $0.754255 |   35% |

DeepSeek took about two thirds of the cost in both games. Seat costs are summed from per-call usage, so they follow the timeline basis. The $0.002845 carried by game B's seam belongs to no seat.

## Comparison with the seed 47 run

The [DeepSeek seed 47 run](2026-09-11-deepseek-v4-1-flash-seed-47.md) held the same board with four DeepSeek seats.

| Measure                    | DeepSeek seed 47 | Mixed pair |
| -------------------------- | ---------------: | ---------: |
| Turns played               |               76 |        135 |
| Cost                       |           $5.727 |     $4.222 |
| Cost per turn              |          $0.0754 |    $0.0312 |
| Cost per million tokens    |          $0.1599 |    $0.0521 |
| Cache-read share of tokens |              67% |        89% |
| Billed input               |        9,586,118 |  5,511,075 |
| Billed output              |        2,256,432 |  1,282,173 |

The mixed pair played 78% more turns and cost 26% less. Two effects explain this. Luna writes far less output than DeepSeek and pays less for input. The mixed games also leaned much harder on cached input, and a cache read costs nothing on DeepSeek and $0.02 per million tokens on Luna.

## Play observations

| Measure                      | Game A | Game B | Seed 47 |
| ---------------------------- | -----: | -----: | ------: |
| Game decisions               |    262 |    259 |     345 |
| Failed game decisions        |      0 |      0 |      19 |
| Negotiation decisions        |    280 |    284 |     322 |
| Failed negotiation decisions |      8 |      8 |      14 |
| Offers                       |     66 |     64 |      55 |
| Accepted offers              |      3 |     13 |      11 |
| Messages                     |     30 |     28 |       5 |
| Robber moves                 |     13 |     16 |      16 |
| Development cards bought     |     12 |     14 |      12 |
| Knights played               |      4 |      7 |       5 |
| Minutes per turn             |   1.09 |   1.14 |    3.73 |

Game A is the low-trade game of the pair. Three accepted offers in 68 turns is far below the seed 47 run, which accepted 11 offers in 77 turns. Game B accepted 13.

## Behaviour compared with the seed 47 run

The three games hold the same board and the same seat count. Only the model set differs, and the seat sets are swapped inside the pair. The differences below are behavioural observations. They are not strength evidence.

### The trade market decided the game

| Game                 | Offers | Accepted | Acceptance rate |
| -------------------- | -----: | -------: | --------------: |
| Seed 47 (4 DeepSeek) |     55 |       11 |             20% |
| Mixed A              |     66 |        3 |        **4.5%** |
| Mixed B              |     64 |       13 |             20% |

Game A held a dead market. No seat reached 9 public points, and the winner took its last two points from Longest Road on the final turn. Game B held a working market. The two mixed games differ from each other as much as the pair differs from the baseline.

### Counteroffers appeared for the first time

Seed 47 recorded zero counteroffers in 55 offers. Its seats refused an offer or let it expire. The mixed games recorded 15 counteroffers in game A (Luna 9, DeepSeek 6) and 6 in game B (all Luna). A second bargaining round is new behaviour in this corpus.

### DeepSeek raises its price, Luna repeats its price

| Seat set          | Offers | Offers giving two or more resources |
| ----------------- | -----: | ----------------------------------: |
| DeepSeek, seed 47 |     55 |                                  27 |
| DeepSeek, mixed   |     62 |                                  16 |
| Luna, mixed       |     68 |                                   1 |

The chat shows the same split. DeepSeek wrote: "Orange: paying 2 ore for your 1 grain — post it and I'll accept instantly", after opening at one for one. Luna held one for one in every offer. In game A, all 23 of Luna's messages asked for lumber. In game B, 16 of 22 did.

### The chat channel changed hands, and the coalition message disappeared

| Game    | Messages | Anti-leader messages |
| ------- | -------: | -------------------: |
| Seed 47 |        5 |                    3 |
| Mixed A |       30 |                    0 |
| Mixed B |       28 |                    0 |

In the seed 47 run, White used the public channel to organize a grain embargo against Red. No such message appears in either mixed game, even in game B where Red sat at 9 points for 16 turns. Luna sent 23 messages in game A and 22 in game B. DeepSeek sent 7 and 6.

### The embargo became private, and the leader paid the port instead

Game B, after Red reached 9 points on turn 54:

| Turn | Red's offer              | Result   |
| ---- | ------------------------ | -------- |
| 53   | lumber for ore           | rejected |
| 57   | wool for ore             | expired  |
| 61   | wool for ore             | rejected |
| 65   | lumber and brick for ore | rejected |

DeepSeek recorded its motive in a refusal: "I already have enough grain for a city (which boosts grain production) and prefer to keep wool and avoid arming a rival."

Red answered at the port rather than in the chat. It traded two lumber for one ore on turn 60, two lumber for one ore again on turn 60, and four for one on turn 68. It built the winning city on turn 69. Denial cost this leader 15 turns. In the seed 47 run, denial cost Red 28 turns.

### DeepSeek reasons about the opponent, Luna reasons about itself

Share of decision reasons that mention a rival, a threat, denial, or the race:

| Seat set          | Reasons | Rival mentions |
| ----------------- | ------: | -------------: |
| DeepSeek, seed 47 |     291 |      22 (7.6%) |
| DeepSeek, mixed A |     129 |       6 (4.7%) |
| DeepSeek, mixed B |     134 |       8 (6.0%) |
| Luna, mixed A     |     134 |       1 (0.7%) |
| Luna, mixed B     |     133 |       1 (0.8%) |

Luna's reasons read like build plans. One example: "Keep the ore because the offered brick does not address the missing lumber and wool."

### Luna decides faster, and it makes malformed offers

| Measure                     |      Luna |  DeepSeek | Seed 47 DeepSeek |
| --------------------------- | --------: | --------: | ---------------: |
| Median game decision        | 2.9–3.1 s | 4.1–6.2 s |            6.3 s |
| Median negotiation decision | 3.5–3.6 s | 5.5–7.3 s |            7.9 s |
| Decision failure rate       |  0.8–1.9% |  1.1–2.1% |             4.9% |
| Offers the referee rejected |   7 of 68 |   0 of 62 |          0 of 55 |

The last row counts offers the engine rejected as structurally invalid, four in game A and three in game B. One of them was a public offer with no target. The cause was not proven. The likely cause is a resource Luna did not hold. This is the clearest quality gap in the pair.

### The robber followed the leader, and the winner was the magnet

| Game    | Most robbed seat          | Outcome |
| ------- | ------------------------- | ------- |
| Seed 47 | Red, the leader, 10 hits  | won     |
| Mixed A | Orange (DeepSeek), 7 hits | won     |
| Mixed B | Red (DeepSeek), 7 hits    | won     |

In game A the two DeepSeek seats spent 9 of 13 robber moves robbing each other. Luna's Red was never robbed.

### No same-model cartel

Cross-model offers outnumbered same-model offers by more than the pair count predicts, and completed trades did the same in game B: 10 cross-model trades against 3 same-model trades. The two seats of one model did not favour each other.

### The economies stayed smaller

| Measure           | Seed 47 | Mixed A | Mixed B |
| ----------------- | ------: | ------: | ------: |
| Cities built      |       8 |       3 |       3 |
| Settlements built |      12 |       9 |       7 |
| Maritime trades   |      26 |       4 |      12 |

The mixed games never developed the board as far. The dead market in game A is the direct cause there.

### Limits on these observations

Two mixed games on one seed show a behavioural difference, not a strength difference. Games A and B disagree on the most important measure, the trade rate, so most findings above rest on a single game. The difference that holds in both mixed games is the reasoning style: DeepSeek raises its price and names rivals, and Luna holds its price and talks about its own build.

## Thinking level: high against xhigh

Luna has thinking levels above `high`. DeepSeek does not have usable headroom, so the second pair raises Luna only. The board, the seats, the flags, and the model set stay the same, so the level is the single change against the first pair.

A one-decision probe settled the provider question first:

| Model    | Level   | Output tokens | Latency |      Cost |
| -------- | ------- | ------------: | ------: | --------: |
| DeepSeek | `high`  |         2,004 |  10.3 s | $0.004684 |
| DeepSeek | `xhigh` |         5,822 |  26.3 s | $0.007038 |
| DeepSeek | `max`   |        28,110 | 120.1 s | $0.036280 |
| Luna     | `xhigh` |         1,229 |  15.0 s | $0.003423 |

The probe used one sample per row, so the output counts carry sampling noise. Three findings came out of it:

1. The Hugging Face router accepts `xhigh` and `max` for the DeepSeek model, although Novita documents only `low` and `high` for it. A later probe found that the route takes seven names and refuses numbers, so the numeric effort of 1 to 100 in the model card is not reachable there. See [Thinking levels](THINKING_LEVELS.md).
2. `max` looked unusable for a full game, because one setup decision took 28,110 output tokens and 120 seconds. A follow-up test with five samples per level shows that this row is an outlier: the `max` median is 8,012 reasoning tokens against 6,409 for `high`, and `high` produced a 19,816-token sample itself.
3. Luna accepts `xhigh` on the OpenAI Responses API.

The CLI holds one `--thinking` level for the whole game. To raise Luna alone, the run used a copy of the model store in which the DeepSeek entry maps `xhigh` to `high`. Every other value, including the cost table, is unchanged. The resolved level maps were checked with a read-only tool before the launch. The launch record is `/home/onur/scratch/catanarchy-luna-xhigh-seed47-launch.json`, and it holds the full flag list and the resolved maps.

### The xhigh pair

| Field                | Game A                                              | Game B                                              |
| -------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Run ID               | `luna-xhigh-seed47-a`                               | `luna-xhigh-seed47-b`                               |
| Status               | Completed                                           | Completed                                           |
| Winner               | Blue (DeepSeek)                                     | White (DeepSeek)                                    |
| Winning turn         | 66                                                  | 75                                                  |
| Turns ended          | 65                                                  | 74                                                  |
| Started              | 2026-09-12 07:34:11 UTC                             | 2026-09-12 07:34:13 UTC                             |
| Finished             | 2026-09-12 08:55:21 UTC                             | 2026-09-12 09:09:14 UTC                             |
| Duration             | 81 minutes                                          | 95 minutes                                          |
| Cost                 | $2.0057                                             | $2.5412                                             |
| Local source package | `/home/onur/scratch/catanarchy-luna-xhigh-seed47-a` | `/home/onur/scratch/catanarchy-luna-xhigh-seed47-b` |

The seats match the first pair: in game A Luna holds red and white, and in game B DeepSeek holds red and white. Each model starts one game and holds each of the four seats once across the pair.

Effective victory points, from the replayed final state:

| Pair  | Game | DeepSeek seats | Luna seats |
| ----- | ---- | -------------: | ---------: |
| high  | A    |             16 |          9 |
| high  | B    |             16 |         10 |
| xhigh | A    |             17 |         12 |
| xhigh | B    |             19 |         15 |

DeepSeek won all four games. Luna's share of the victory points rose from 19 of 51 to 27 of 63.

### Cost, tokens, and time

| Measure                   | high pair        | xhigh pair       |
| ------------------------- | ---------------- | ---------------- |
| Pair cost                 | $4.2114          | $4.5469          |
| Luna cost                 | $1.4455          | $1.6377          |
| DeepSeek cost             | $2.7659          | $2.9092          |
| Luna output tokens        | 125,312          | 227,316          |
| DeepSeek output tokens    | 1,156,861        | 1,242,826        |
| Luna cache write          | 1,853,722        | 1,767,373        |
| Calls, Luna               | 523              | 549              |
| Calls, DeepSeek           | 562              | 602              |
| Median decision, Luna     | 2,899 / 3,117 ms | 3,107 / 3,578 ms |
| Median decision, DeepSeek | 4,089 / 6,022 ms | 4,450 / 4,362 ms |
| Active minutes, A / B     | 73.2 / 77.2      | 81.2 / 95.0      |

Luna's thinking output rose by 81%. Her cost rose by 13%, and the pair cost rose by 8%. DeepSeek ran at `high` in both pairs, so its own cost rise comes from the longer games and the larger number of calls.

A deeper level is cheap on this harness. The wall clock is the real cost: the xhigh games took 11% and 23% longer.

### Behaviour

| Game    | Offers | Accepted | Counteroffers | Messages |
| ------- | -----: | -------: | ------------: | -------: |
| high A  |     66 |        3 |            15 |       30 |
| xhigh A |     77 |        5 |            22 |       32 |
| high B  |     64 |       13 |             6 |       28 |
| xhigh B |     62 |       10 |             9 |       18 |

Game A was a dead market at both levels. Game B traded normally at both levels. The level did not change the market behaviour in a consistent direction. The counteroffer count rose in game A and fell in game B.

### Limits on the level comparison

- Two games per level cannot support a strength claim. The outcome did not change, and deeper thinking flipped no game.
- Luna's victory points improved in both games, from 9 to 12 and from 10 to 15. Two games cannot separate that from luck, and an improvement in points while losing every game is not a win-rate result.
- DeepSeek changed level between the pairs only in the sense that the store held it at `high`. Its calls and output rose with the longer games, so its column is not a clean control either.
- The probe rows are single samples. The `max` figure in particular comes from one call, and [Thinking levels](THINKING_LEVELS.md) shows that five samples per level put `max` only about a quarter above `high`.

## Reproduction

The launch record for the original pair is `/home/onur/scratch/catanarchy-luna-mixed-seed47-launch.json`. The resume record is `/home/onur/scratch/catanarchy-luna-mixed-seed47-resume.json`. Both hold the full flag list. The run manifest does not record the launch configuration, so these files are the source for it.

The original games ran at commit `6980d4d`. The resume ran at commit `6606923`, which contains the resume feature. The engine rules did not change between the two, so each game continued under the same rules it started with.

## Limits

- Two games on one seed cannot support a strength claim about either model.
- Hidden victory-point cards are private. Their count appears here because the final state was replayed from the run timeline.
- The stop cause is unknown, and one resumed pair does not prove that it cannot happen again.
- The behavioural findings rest on two games. Where the two games disagree, the note says so.
- The seed 47 comparison uses a different model count per seat set. The seed 47 run held four DeepSeek seats, and the pair held two.
- Both packages are in the public Bucket `osolmaz/catanarchy-runs`. A scan found no credential. The provider `thinkingSignature` blobs in two Luna sessions match a `sk-` or `hf_` prefix by chance inside a long opaque string.
- The xhigh pair is published in the same Bucket at `runs/luna-xhigh-seed47-a` and `runs/luna-xhigh-seed47-b`. All four packages carry this report.
- The level comparison rests on two games per level. Treat every difference in it as a case study, not as an effect size.

## Related documents

- [Run log format](RUN_LOG.md) defines the run package.
- [Resume](RESUME.md) defines the resume contract used by both games.
- [Agent harness](AGENT_HARNESS.md) defines the seat harness and the pause boundary.
- [DeepSeek V4.1 Flash seed 47 run report](2026-09-11-deepseek-v4-1-flash-seed-47.md) is the single-model run on the same board.
- [Terra seed 47 run report at thinking max](2026-09-12-terra-seed-47.md) is the third pair on the same board.
