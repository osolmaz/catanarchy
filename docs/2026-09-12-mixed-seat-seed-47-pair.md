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
| Resumed              | 2026-09-12 05:12:31 UTC, warm                       | 2026-09-12 05:12:31 UTC, warm                       |
| Pi version           | 0.85.1                                              | 0.85.1                                              |
| Local source package | `/home/onur/scratch/catanarchy-luna-mixed-seed47-a` | `/home/onur/scratch/catanarchy-luna-mixed-seed47-b` |

Seat assignment:

| Seat   | Game A   | Game B   |
| ------ | -------- | -------- |
| Red    | Luna     | DeepSeek |
| Blue   | DeepSeek | Luna     |
| White  | Luna     | DeepSeek |
| Orange | DeepSeek | Luna     |

Both games used one negotiation round per window, thinking level `high`, a 131072-token context window, 8 planning steps, a 600000 ms turn time, a 60000 ms finalization grace, and a per-game cost ceiling of $60. The run packages follow the [run log format](RUN_LOG.md). They are not published.

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

| Field                      | Game A      | Game B      |
| -------------------------- | ----------- | ----------- |
| Resume record index        | 1517        | 1032        |
| Records dropped by the cut | 2           | 8           |
| Spend carried by the seam  | $0.000000   | $0.002845   |
| Replayed game sequence     | 198         | 140         |
| State verification         | exact       | exact       |
| Resumed segment duration   | 29 min 24 s | 33 min 39 s |
| Stop repeated              | no          | no          |

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

| Measure                      | Game A | Game B |
| ---------------------------- | -----: | -----: |
| Game decisions               |    262 |    259 |
| Failed game decisions        |      0 |      0 |
| Negotiation decisions        |    280 |    284 |
| Failed negotiation decisions |      8 |      8 |
| Offers                       |     66 |     64 |
| Accepted offers              |      3 |     13 |
| Messages                     |     30 |     28 |
| Robber moves                 |     13 |     16 |
| Development cards bought     |     12 |     14 |
| Knights played               |      4 |      7 |

Game A is the low-trade game of the pair. Three accepted offers in 68 turns is far below the seed 47 run, which accepted 11 offers in 77 turns. Game B accepted 13.

## Reproduction

The launch record for the original pair is `/home/onur/scratch/catanarchy-luna-mixed-seed47-launch.json`. The resume record is `/home/onur/scratch/catanarchy-luna-mixed-seed47-resume.json`. Both hold the full flag list. The run manifest does not record the launch configuration, so these files are the source for it.

The original games ran at commit `6980d4d`. The resume ran at commit `6606923`, which contains the resume feature. The engine rules did not change between the two, so each game continued under the same rules it started with.

## Limits

- Two games on one seed cannot support a strength claim about either model.
- Hidden victory-point cards are private. Their count appears here because the final state was replayed from the run timeline.
- The stop cause is unknown, and one resumed pair does not prove that it cannot happen again.
- The run packages are local. They are not in the public Bucket.

## Related documents

- [Run log format](RUN_LOG.md) defines the run package.
- [Resume](RESUME.md) defines the resume contract used by both games.
- [Agent harness](AGENT_HARNESS.md) defines the seat harness and the pause boundary.
- [DeepSeek V4.1 Flash seed 47 run report](2026-09-11-deepseek-v4-1-flash-seed-47.md) is the single-model run on the same board.
