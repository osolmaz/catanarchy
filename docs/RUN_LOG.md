# Run log format

## Purpose

A Catanarchy run log is the ordered record of one match. It supports live viewing, exact replay, debugging, model-session inspection, and later training-data export.

The run log is the canonical match record. A Pi session is the canonical model conversation for one seat. These are separate files because game events and model messages have different ordering, privacy, and replay rules.

## Package layout

A completed run uses this layout:

```text
<run-id>/
  manifest.json
  timeline.jsonl
  sessions/
    <pi-session-id>.jsonl
```

`manifest.json` identifies the run and its files. `timeline.jsonl` contains ordered match records. Each file in `sessions/` is a normal Pi session file created by the public Pi `SessionManager` API. The manifest maps each generated Pi session file to its seat.

A live run also holds `run.lock`. The lock is a transient runtime guard, not part of the package. It holds the process ID of the writer and the writer removes it on close. The lock is claimed with its content already written, so it never appears empty and two openers cannot both take it. An opener that finds a lock whose process is gone takes it over. An opener that cannot read the lock treats it as held. Only one process may take over a stale lock, and a lock is removed only while it is still the file the taker linked, so a second taker never clears a lock that the first taker has claimed. A takeover marker whose owner is gone is cleared, so a stale lock never blocks every later opener. A resume takes the lock before it reads the package.

A writer creates the run directory before the match starts. It writes each timeline record to disk before play continues. It updates `manifest.json` with an atomic file replacement. The manifest stays `partial` until the match ends. A stopped run keeps its records and remains clearly marked as partial, failed, or cancelled. If a failed or cancelled run ends during a game command, readers replay the last complete command and retain the unmarked event tail for inspection.

## Manifest

The manifest schema identifier is `catanarchy.run-manifest.v1`.

Required fields:

- `schema`: The exact schema identifier.
- `runId`: A unique, stable run identifier.
- `matchId`: The match identifier used by game and negotiation events.
- `status`: `partial`, `completed`, `failed`, or `cancelled`.
- `startedAt`: An RFC 3339 UTC timestamp.
- `finishedAt`: An RFC 3339 UTC timestamp for a terminal run, or `null`.
- `timeline`: The relative path `timeline.jsonl`.
- `timing`: The exact value `monotonic`.
- `piVersion`: The exact Pi package version, or `null` when the run has no Pi agents.
- `initialStateOrigin`: The generated or observed origin of the starting state.
- `seats`: One entry for each seat.

The origin is one of these values:

```ts
type InitialStateOrigin =
  | { readonly type: "generated"; readonly generatorId: string; readonly seed: number }
  | { readonly type: "observed"; readonly adapterId: string };
```

A native run uses generator ID `catanarchy.standard-board.v1` and the seed passed to `createGame`. An imported board uses an adapter ID and does not claim that the native generator created it. The origin is a provenance claim, not proof that a file was not edited.

Each seat entry has `seatId`, `agentType`, `model`, `sessionId`, and `sessionFile`. `model` has `provider` and `modelId`, or is `null`. `sessionId` and `sessionFile` are `null` for a non-Pi agent. A session path must stay below `sessions/` and must not contain `..` or an absolute path.

Smallest valid completed manifest:

```json
{
  "schema": "catanarchy.run-manifest.v1",
  "runId": "run-42",
  "matchId": "game-42",
  "status": "completed",
  "startedAt": "2026-09-10T10:00:00.000Z",
  "finishedAt": "2026-09-10T10:08:46.105Z",
  "timeline": "timeline.jsonl",
  "timing": "monotonic",
  "piVersion": "0.85.1",
  "initialStateOrigin": {
    "type": "generated",
    "generatorId": "catanarchy.standard-board.v1",
    "seed": 42
  },
  "seats": [
    {
      "seatId": "red",
      "agentType": "pi",
      "model": {
        "provider": "huggingface",
        "modelId": "deepseek-ai/DeepSeek-V4-Flash"
      },
      "sessionId": "018f0000-0000-7000-8000-000000000001",
      "sessionFile": "sessions/2026-09-10T10-00-00_018f0000.jsonl"
    }
  ]
}
```

## Timeline records

`timeline.jsonl` is UTF-8 JSON Lines. Each nonempty line is one JSON object. Every record has these fields:

- `schema`: `catanarchy.run-record.v1`.
- `runId`: The manifest run identifier.
- `index`: A zero-based integer. It increases by exactly one.
- `offsetMs`: A nonnegative integer from a monotonic clock. It cannot decrease.
- `recordedAt`: An RFC 3339 UTC timestamp for operator inspection.
- `kind`: The record discriminator.
- `visibility`: `public`, `referee`, or an object with `type: "seat"` and `seatId`.
- `payload`: The kind-specific value.

Playback uses `offsetMs`, not `recordedAt`. Wall clocks can jump. At speed `n`, the viewer waits `(next.offsetMs - current.offsetMs) / n` milliseconds. The viewer offers 1×, 2×, 5×, 10×, and 20× speeds. It can pause and seek to each visible timeline record. The board changes only after a complete game-command batch.

The first record must have index and offset zero. The final record must have kind `run.completed`, `run.failed`, or `run.cancelled`.

## Record kinds

Version 1 defines these kinds:

- `run.started`: The game configuration, the negotiation round limit the run starts with, and the launch settings. The limit is `null` when negotiation is off, and absent in a package from before the field existed. The `launch` object holds the thinking level, the turn window, the finalization grace, the outer wall clock of one agent call, the context window, the planning-step limit, the attempt limit, the decision bound, the output limit, the negotiation message limits, and the cost ceiling. It is absent in a package from before the field existed.
- `game.event`: One authoritative `catanarchy.game-event.v1` envelope.
- `game.command-completed`: The command ID and last game-event sequence in one complete command batch.
- `negotiation.event`: One `catanarchy.negotiation-event.v1` envelope.
- `game.agent-requested`: One game request with its seat observation, legal actions, and attempt number.
- `game.decision`: One selected, failed, or fallback game decision with model, time, token, and cost data when available. A failed attempt and the fallback that follows it carry the agent error text in `failureMessage`. The record carries the turn key of the decision, and a failure carries `pool` and `remainingMs` when one of the two time pools was already empty.
- `negotiation.agent-requested`: One negotiation request with its seat observation, negotiation view, and attempt number.
- `negotiation.decision`: One selected, failed, or fallback negotiation decision, with the same `failureMessage`, turn key, and pool rule as a game decision.
- `run.completed`: The final game and negotiation sequences and winner, if any, plus `decisionSummary`: the replaced game and negotiation decisions, the failures that spent no tokens because a time pool was empty, and the seats a cancellation timeout quarantined. The summary covers the whole run, including any prefix a resume replayed, and it is absent in a package from before the field existed.
- `run.failed`: A short failure reason and the last saved sequence values.
- `run.cancelled`: A short cancellation reason and the last saved sequence values.
- `run.resumed`: The resume mode, the timeline index the run continues from, the replayed game sequence, the replay verification result, a short reason, and the spend that the removed records held before the resume.

A game command can emit more than one game event. All events with the same `commandId` form one atomic replay batch. A viewer must reduce the complete batch before it displays the next board state.

Example timeline:

```jsonl
{"schema":"catanarchy.run-record.v1","runId":"run-42","index":0,"offsetMs":0,"recordedAt":"2026-09-10T10:00:00.000Z","kind":"run.started","visibility":"public","payload":{"config":{"schema":"catanarchy.game-config.v1","matchId":"game-42","seed":42,"players":[{"id":"red","name":"Red","color":"red"},{"id":"blue","name":"Blue","color":"blue"},{"id":"white","name":"White","color":"white"}]},"negotiationRounds":1}}
{"schema":"catanarchy.run-record.v1","runId":"run-42","index":1,"offsetMs":36064,"recordedAt":"2026-09-10T10:00:36.064Z","kind":"game.decision","visibility":"referee","payload":{"matchId":"game-42","sequence":0,"playerId":"red","attempt":1,"outcome":"selected","elapsedMs":36064,"actionId":"settlement:v:-1:-3"}}
{"schema":"catanarchy.run-record.v1","runId":"run-42","index":2,"offsetMs":36066,"recordedAt":"2026-09-10T10:00:36.066Z","kind":"run.completed","visibility":"public","payload":{"gameSequence":1,"negotiationSequence":-1,"winnerPlayerId":null}}
```

## Pi session compatibility

Catanarchy does not copy or redefine Pi's session schema. For Pi agents, it creates one persistent session per seat with the documented public call `SessionManager.create(cwd, sessionDirectory)`. Pi writes its native versioned JSONL entries. The manifest records the returned session ID and file path.

A warm resume restores a seat with the documented public call `SessionManager.open(path)`, so the seat continues its recorded conversation instead of starting a new one.

This gives each seat a session that Pi can open directly with `SessionManager.open(path)`. It also preserves Pi's normal message and tool-call structure without putting private seat messages in the public timeline.

The trusted local viewer can download each native Pi session file. A future remote viewer will use a server-side projection. That projection can expose public chat, selected actions, short reasons, timing, and usage. It must not send hidden observations, directed messages for another seat, model reasoning, credentials, or raw provider data to a public browser.

Imported runs that have only the old result JSON cannot recover raw Pi messages or exact wall-clock timing. Their viewer uses recorded model-call durations where available and a one-second fallback for missing intervals. The UI must label that timing source.

## Resume

A stopped run can continue. The timeline is the state, so a resume replays the stored prefix and appends to the same log. It creates no second state format and no forked run directory. `docs/RESUME.md` holds the full contract.

`RunRecorder.create` starts a run and `RunRecorder.open` continues one. `open` takes the run lock, then validates the package, refuses a terminal run, refuses a prefix that does not replay, and appends one `run.resumed` record before play continues. It returns the absolute session file of every Pi seat in `warm` mode. The recorder keeps the stored `runId`, `matchId`, `startedAt`, `initialStateOrigin`, and seats. New records continue the index and offset sequences without a gap and without a repeat. Because the offset baseline moves back by the stored offset, a record from a resumed process reports the stored offset plus the elapsed time of that process.

A resume starts at the last completed command. Everything the log holds after that record is incomplete work that no command covers, such as a negotiation window that stopped halfway. `open` removes that tail before it appends, so the file keeps exactly one line per record and the negotiation sequence stays contiguous. The removal measures the prefix in bytes, because a message can hold characters that take more than one byte, and it counts records rather than physical lines, because a blank line carries no record. A torn final line is discarded the same way.

The resume value reports the replayed state, the prefix events, the negotiation events of the prefix, the committed decision count, the recorded spend, the index the run continues from, and the round limit of the first negotiation window. That round limit comes from the start record, and falls back to the first window for a package that predates the field, so a run that stopped before its first window still keeps the limit it began with. A run that recorded negotiation as off reports zero rounds.

One prefix cannot resume. An accepted trade writes its command marker while the window is open, so the last completed command can sit inside a live negotiation round. That run stays partial, `readRunPackage` reports `resume: null` with a `resumeBlockedReason`, and `open` refuses it before any write. Reseating a model or changing the game configuration stays out of scope.

`RunRecorder.close` closes a recorder without a terminal record. The run stays partial and another process can resume it.

The resume mode is one of two values:

| Mode   | Board and hands       | Seat memory                                              |
| ------ | --------------------- | -------------------------------------------------------- |
| `warm` | restored from the log | restored from the session file that the manifest records |
| `cold` | restored from the log | a new session file, recorded after it exists             |

A warm resume needs every Pi seat to name a session file that still exists. A cold resume is a different experiment, because the seat has no memory of the earlier play.

## Validation

A reader rejects a package when:

- a schema identifier is unknown
- IDs do not agree with the manifest
- timeline indexes have a gap or duplicate
- monotonic offsets decrease
- a recorded spend is not a non-negative number
- a timeline that ends with a terminal record presents itself as partial
- a terminal manifest has no matching terminal record
- the complete stored starting state does not decode or breaks an engine invariant
- a game event sequence is invalid
- a generated run's later atomic command batch does not match native command execution
- a generated origin does not agree with the starting-state seed
- a seat session path escapes the package
- a public projection contains a seat-private record

Unknown record kinds are rejected in version 1. Adding a kind to version 1 requires a reader update in the same change, as `run.resumed` did. A reader that meets an unknown kind rejects the package instead of skipping the record.

## Loading and seeking

A loader validates the manifest before it opens referenced files. It uses the complete state in `game.created` as the replay starting point and replays later events only at complete command boundaries. For a generated run, it separately checks exact native command execution and reports whether the starting state matches the current native generator. An observed run reports that both native generator matching and native command reproduction do not apply. A generator mismatch does not make an otherwise valid replay fail.

The current local viewer loads the run into memory and creates a frame for each visible record. A later large-run loader can add a sparse index from timeline index and game sequence to byte offset.

Checkpoints are derived cache data. They are not authoritative and can be deleted and rebuilt from `timeline.jsonl`.

## Security and privacy

The referee package can contain all seat sessions and private observations. It is not safe to publish. Public and seat-specific bundles are generated projections with their own manifests. Redaction happens before serialization, not in browser code.

No file can contain API keys, authorization headers, environment values, or credential-store data. Provider error text is bounded and scrubbed before it enters a record.
