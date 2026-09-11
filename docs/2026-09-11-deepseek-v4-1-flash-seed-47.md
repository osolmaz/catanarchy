---
title: DeepSeek V4.1 Flash seed 47 run report
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-11
tags:
  - agents
  - negotiation
  - run-report
---

# DeepSeek V4.1 Flash seed 47 run report

## Run identity

This was the first completed four-agent Catanarchy game used to inspect normal play, trading, and public arguments over a full match.

| Field | Value |
| --- | --- |
| Run ID | `v41-full-seed47` |
| Match ID | `pi-game-47` |
| Board seed | 47 |
| Status | Completed |
| Winner | Red |
| Winning turn | 77 |
| Started | 2026-09-11 05:39:22 UTC |
| Finished | 2026-09-11 10:23:04 UTC |
| Pi version | 0.85.1 |
| Model for all seats | `huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita` |
| Local source package | `/home/onur/scratch/catanarchy-v41-full-seed47` |
| Private Bucket | `hf://buckets/osolmaz/catanarchy-runs/runs/v41-full-seed47` |

The run package follows the [run log format](RUN_LOG.md). It contains the full referee timeline and one native Pi session for each seat.

## Result

Red won with 10 public points and no development cards. Longest Road supplied the last two points in Red's score.

| Player | Settlements | Cities | Roads | Public points | Hidden VP cards | Effective total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Red | 4 | 2 | 11 | 10 | 0 | **10** |
| White | 0 | 4 | 6 | 8 | 1 | **9** |
| Orange | 3 | 2 | 7 | 7 | 1 | **8** |
| Blue | 5 | 0 | 8 | 5 | 2 | **7** |

White had played two knights and still held a third knight. Largest Army was unclaimed. If Red had not won first, White could play the third knight on its next turn and gain two points. This made the final round a close race rather than a routine finish.

## Score progression

The main changes in the lead were:

- Red reached 5 points on turn 21.
- Blue claimed Longest Road with length 5 on turn 38.
- Red took Longest Road with length 6 on turn 41 and moved from 6 to 8 public points.
- Red reached 9 public points on turn 49.
- White reached 8 public points on turn 59 and drew a hidden victory-point card on turn 67.
- Orange reached 7 public points on turn 68 and drew a hidden victory-point card on turn 76.
- Red built the winning city on turn 77.

Red stayed at 9 points for 28 turns. The other agents denied grain, moved the robber onto Red's production, and stole resources during this period.

## Table coordination

The strongest result from the run was a real anti-leader argument.

On turn 65, White sent this public message:

> Careful: Red sits at 9 VP with Longest Road and is fishing for grain (just offered wool+ore for grain). Any grain Red receives funds a city and ends the game immediately. Please don't sell grain to Red.

White repeated the warning on turns 68 and 73. On turn 73, Red offered three lumber and three wool for one grain. Blue rejected the offer and recorded this reason:

> Refuse to hand the leader the grain that could complete a winning city.

Orange also recorded that it would not give grain to the 9-point leader. This is evidence that the agents could use public arguments and threat assessment in trade decisions. One run cannot show how much the messages caused the refusals because the public score also exposed Red's lead.

All five free-form messages came from White. The first was a directed future-trade message. The other four were public trade or leader warnings.

## Trading

| Item | Count |
| --- | ---: |
| Negotiation windows | 77 |
| Player trade offers | 55 |
| Accepted player trades | 11 |
| Closed offers | 44 |
| Maritime trades | 26 |
| Free-form messages | 5 |
| Passes | 208 |
| Counteroffers | 0 |

Fifty-four offers were public and one was directed. Eight of the 11 completed player trades occurred by turn 26. Only three player trades occurred after turn 49, and none gave Red the grain needed for the winning city.

The 26 maritime trades were split as follows:

| Player | Maritime trades | Main rates used |
| --- | ---: | --- |
| White | 11 | Nine at 3:1 and two at 4:1 |
| Blue | 7 | Four at 2:1 and three at 4:1 |
| Orange | 6 | Six at 3:1 |
| Red | 2 | Two at 2:1 |

The negotiation protocol allowed offers and public arguments, but one round per turn prevented real back-and-forth bargaining. No agent made a counteroffer.

## Robber and discards

Red received most of the defensive pressure.

| Player | Times robbed | Resources discarded |
| --- | ---: | ---: |
| Red | 10 | 25 |
| White | 5 | 17 |
| Blue | 1 | 8 |
| Orange | 0 | 4 |

The game had 16 robber moves. Nine of the final 13 robber moves targeted Red after Red took Longest Road. Red also kept large ore reserves while waiting for grain, which made rolls of seven expensive.

## Opening placements

The agents chose productive openings and covered all five resources with their two starting settlements.

| Player | Combined probability pips | Resource coverage |
| --- | ---: | --- |
| White | 22 | All five resources |
| Red | 19 | All five resources |
| Blue | 19 | All five resources |
| Orange | 19 | All five resources |

Red's first road pointed toward `v:4:-2`, but Blue took that settlement location with the next placement. The other opening reasons generally matched the board and the selected locations.

## Dice

The 77 dice results were:

| Sum | Rolls |
| --- | ---: |
| 2 | 0 |
| 3 | 6 |
| 4 | 2 |
| 5 | 11 |
| 6 | 11 |
| 7 | 11 |
| 8 | 16 |
| 9 | 9 |
| 10 | 5 |
| 11 | 3 |
| 12 | 3 |

Eight occurred often and four occurred rarely in this one game. This is descriptive only. One game is too small to support a claim about dice fairness.

## Model use and cost

The complete run reported **$5.727393252** in model charges.

| Usage | Total |
| --- | ---: |
| Model calls | 634 |
| Successful decisions | 601 |
| Failed calls | 33 |
| Fresh input tokens | 9,586,118 |
| Output tokens | 2,256,432 |
| Cache-read tokens | 23,973,242 |
| Cache-write tokens | 0 |
| Total processed tokens | 35,815,792 |
| Wall time | 4 hours 43 minutes 42 seconds |
| Model-call time | 4 hours 43 minutes 32 seconds |

Model latency accounted for nearly all elapsed time. Local harness overhead was about 10 seconds.

### Use by activity

| Activity | Calls | Processed tokens | Cost | Model-call time |
| --- | ---: | ---: | ---: | ---: |
| Game decisions | 326 | 18,372,210 | $3.027430728 | 2 hours 32 minutes |
| Negotiation decisions | 308 | 17,443,582 | $2.699962524 | 2 hours 12 minutes |

Negotiation used almost half the time and cost even though 208 decisions were passes.

### Use by seat

| Seat | Calls | Processed tokens | Failed calls | Cost |
| --- | ---: | ---: | ---: | ---: |
| Red | 165 | 9,554,438 | 17 | $1.357392216 |
| Blue | 154 | 8,783,083 | 8 | $1.310273304 |
| White | 167 | 8,957,256 | 2 | $1.520161176 |
| Orange | 148 | 8,521,015 | 6 | $1.539566556 |

The $500 run ceiling was an upper safety limit. It was not the amount spent. The cost above includes the model usage recorded by Catanarchy and excludes local electricity and machine costs.

## Reliability notes

Nineteen game calls and 14 negotiation calls ended with an agent error. The harness selected a legal fallback each time, so the match completed and no illegal command reached the engine. These fallbacks mean the result is not a pure sample of model-selected play. Fallbacks included roads, rolls, robber moves, discards, a maritime trade, a development-card purchase, and end-turn actions.

Of the 307 successful game decisions, 306 used the structured tool and one used text selection. The structured legal-action interface worked well.

## Main findings

1. Public argument changed the character of the endgame. The agents identified a leader, discussed the leader's resource bottleneck, and denied the decisive trade.
2. Hidden cards made the public standings misleading. White was at 9 effective points and Blue was at 7 despite lower public scores.
3. Red won through board development and Longest Road without development cards.
4. One negotiation call for every seat on every turn was expensive. Many of those calls produced a pass.
5. One negotiation round allowed warnings and offers but prevented bargaining and counteroffers.
6. Legal-action tools prevented illegal engine commands, while fallback actions kept provider failures from stopping the match.

## Follow-up questions

- Add multi-round bargaining so agents can counteroffer and respond to arguments.
- Reduce the cost of obvious negotiation passes without removing the chance to speak.
- Separate model-selected actions from fallback actions in benchmark scores.
- Run repeated seeds before comparing models or drawing conclusions about playing strength.
- Measure whether public warnings change trade acceptance against a no-chat control.
