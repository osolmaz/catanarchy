# Resume

## Purpose

A long match can stop before it ends. The process can be killed, the machine can restart, or an operator can stop it deliberately. Today the run keeps every record it wrote and stays marked `partial`, but the match cannot continue. The operator must start a new run and pay for the played part again.

This document is the implementation contract for continuing a stopped match.

## The principle

The timeline is the state. A run package is already an event-sourced append-only log, and the engine already replays it. `docs/ENGINE.md` requires that a replay from the same configuration and commands produces the same events and state.

Resume is therefore a read followed by an append to the same log. It is not a snapshot, a checkpoint, or a second state format.

The consequences are deliberate:

- No new persisted file type. A run still holds `manifest.json`, `timeline.jsonl`, and `sessions/`.
- No second copy of the state that can drift from the log.
- Derived caches stay derived. `docs/RUN_LOG.md` already states that checkpoints are cache data that can be deleted and rebuilt from `timeline.jsonl`.

## Resume boundary

A resume starts at a completed command boundary. It never starts inside a negotiation round, inside a model call, or inside a partially applied command.

This is the same boundary that `--pause-after-decisions` already waits at. Pause and resume share one boundary definition: pause stops a live process, resume restarts a dead one.

A stop can leave records after that boundary. A negotiation window that stopped halfway, or game events of a command that never completed, are incomplete work. The resumed run plays them again. `open` therefore removes those records before it appends, so the log keeps one record per index and one sequence number per negotiation event. The removed tail is not a rewind: it holds no committed command.

One stop cannot resume at all. An accepted trade writes its command marker while its window is still open, so the last completed command can sit inside a live negotiation round. That boundary cannot continue. The trade is already applied, the remaining rounds of the window are gone, a window cannot replay from its middle, and a committed command must not be discarded. `open` refuses such a run before it writes, and the package reports the reason.

## Resume modes

A resumed match keeps its board and hands. Its agent memory depends on the mode, and the difference is recorded.

| Mode   | Board and hands | Seat agent memory                            |
| ------ | --------------- | -------------------------------------------- |
| `warm` | kept            | kept, restored from each seat session file   |
| `cold` | kept            | fresh session, no memory of the earlier play |

A `cold` resume is a different experiment. Both modes must appear in the timeline, and analysis must read that record before it mixes a resumed match with an uninterrupted one.

## The stage model

| Stage    | Run directory | Timeline | Seat sessions       |
| -------- | ------------- | -------- | ------------------- |
| `create` | created       | created  | created             |
| `resume` | opened        | appended | restored or created |

Only these two stages exist. There is no merge stage and no forked run directory.

## Requirements

### Run log

1. Add `RunRecorder.open` beside `RunRecorder.create`. It accepts a run directory that already exists.
2. `open` validates the package with `readRunPackage` before it appends anything.
3. `open` refuses a run whose last record is `run.completed`, `run.failed`, or `run.cancelled`. A finished run is final. A process can die between the terminal append and the manifest write, so the last record is checked as well as the manifest status.
4. `open` restores `index` and `offsetMs` from the last record of the prefix. The next record continues the sequence with no gap and no repeat. Records after the prefix are removed first. The offset baseline moves back by the stored offset, so a resumed record reports the stored offset plus the time the new process took.
5. `open` keeps `runId`, `matchId`, `startedAt`, and `initialStateOrigin` from the stored manifest unchanged. A resume must not rewrite the identity or the start time of the run.
6. `open` opens the timeline for append. `create` keeps exclusive creation.
7. `open` takes the lock before it reads the package. The lock appears with its content already written, so two openers cannot both take it over. A second process that tries to open the same run fails before it writes. A lock with a live holder is refused, a lock with a dead holder is taken over, and a lock that cannot be read counts as held. A writer releases only a lock that still names it. The resume decision, the restored prefix, and the removal of later records all happen under the lock, so a stale read cannot act on a timeline that another writer changed. One process may take over a stale lock. A taker links the stale lock to a name that carries the dead holder, and removes the lock only while it is still the file the taker linked, so a second taker never removes a lock that the first taker has already claimed.
8. `open` appends a `run.resumed` record as its first write.
9. `complete`, `fail`, and `cancel` behave on a resumed run exactly as they do on a created one.

### Record kind

`run.resumed` joins the version 1 kind set. Its payload holds:

- `mode`: `warm` or `cold`.
- `resumedAtIndex`: The timeline index the run continues from.
- `replayedSequence`: The last game-event sequence in the replayed state.
- `verification`: The replay verification result for the stored prefix.
- `reason`: A bounded operator reason.
- `priorSpendUsd`: Spend that an earlier attempt already incurred and that this resume removes from the timeline. The seam carries it, so the whole-run ceiling still counts it.

`docs/RUN_LOG.md` states that unknown record kinds are rejected, so readers must learn this kind in the same change. The cutover rule applies: extend version 1 in place and update every reader. Do not add a version 2 for compatibility.

### Harness

10. `runWithAgents` accepts an optional starting state and its events. When they are present it does not call `createGame`.
11. The decision count continues from the resumed count. A resumed run with a `--decisions` limit must not receive a fresh full limit.
12. The negotiation window counter and the negotiated-turn set continue from the replayed state. A resumed run must not reopen a negotiation window that already closed. The prefix ends with a closed window, or before the window that the stop cut in half.
13. The harness verifies the replayed prefix before it plays. A prefix that does not replay is a hard failure, not a warning.

### Pi agent

14. `PiAgentFactoryOptions` gains optional restored session entries for each seat.
15. A `warm` resume restores each seat session from the file the manifest already records. The seat keeps its plans, its private knowledge, and its earlier messages.
16. A `cold` resume creates a fresh session and records the new session file for that seat, replacing the stored value only after the new session exists.
17. The seat count and the model assigned to each seat stay as the manifest records them. A resume must not silently reassign a model to a seat.

### Cost budget

18. A resumed run recomputes observed spend from the usage records already in the timeline. Records after the prefix are removed, so the record that replaces them carries the spend they held in `priorSpendUsd`.
19. The cost ceiling applies to the whole run, not to the part after the resume. A resume must not hand the run a second full ceiling. The carried spend keeps that true after a second and later resume.
20. The next-request exposure check runs before the first resumed request, as it does on a fresh run.

### Command line

21. Add a `resume` subcommand: `resume --run-dir=<path> --mode=warm|cold`. The existing flag set keeps its current meaning.
22. A run started without the subcommand behaves exactly as it does today.

## Validation

A resumed run fails before it writes when:

- the run directory does not exist
- the manifest or timeline does not validate
- the last record is terminal
- the stored prefix does not replay to a complete command boundary
- the completed command at the end of the prefix is inside an open negotiation window
- the state after replay fails an engine invariant
- a seat session file named by the manifest is missing in `warm` mode
- another process holds the run lock

A reader of a resumed run reports:

- that the run was resumed, and at which index
- the mode, because agent memory differs between modes
- whether the replayed prefix reproduced the stored events exactly

## Tests

| Test                                                                                                                | Property                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Resume a partial run with scripted agents and play to the end; compare with an uninterrupted run of the same length | Identical final state and identical events                                            |
| Resume a terminal run                                                                                               | Refused before any write                                                              |
| Resume when the stored prefix does not replay                                                                       | Refused before any write                                                              |
| Two processes open one run                                                                                          | Exactly one proceeds                                                                  |
| Resume in `warm` mode                                                                                               | The seat session keeps its earlier messages                                           |
| Resume in `cold` mode                                                                                               | The state matches, the memory differs, and the timeline says so                       |
| Resume across a replayed negotiation window                                                                         | The closed window does not reopen                                                     |
| Resume a run that stopped inside a negotiation window                                                               | The half-played window is removed, the log stays readable, and that window opens once |
| Resume a run that stopped at an accepted trade                                                                      | Refused before any write                                                              |
| Resume with a revised cost ceiling                                                                                  | Observed spend carries over and the ceiling covers the whole run                      |
| Resume with a truncated final line                                                                                  | Rejected, or trimmed at the boundary, and never silently accepted                     |
| Record `run.resumed`                                                                                                | A current reader accepts it and an analysis tool can find the seam                    |

## Out of scope

- Parallel match execution and batch manifests.
- Work stealing, job queues, or a scheduler.
- Rewinding to an earlier point. Resume continues from the last completed command only, and it never discards a committed command.
- Replacing a seat model or a game configuration mid-run.
- Changing a completed run.

## Related documents

- `docs/RUN_LOG.md` defines the run package and its validation rules.
- `docs/ENGINE.md` defines deterministic replay.
- `docs/AGENT_HARNESS.md` defines the seat harness and the pause boundary.
