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

A writer first creates the package in a temporary directory. It appends and flushes records while the match runs. It writes completion data to the manifest only after the final timeline record and all Pi sessions are durable. It then renames the package to its final path. An interrupted package remains marked as partial and must not be presented as complete.

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
- `timing`: `monotonic` when all records have captured offsets, or `synthetic` for an imported old report.
- `piVersion`: The exact Pi package version, or `null` when the run has no Pi agents.
- `seats`: One entry for each seat.

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

Playback uses `offsetMs`, not `recordedAt`. Wall clocks can jump. At speed `n`, the viewer waits `(next.offsetMs - current.offsetMs) / n` milliseconds. The viewer offers 1×, 2×, 5×, 10×, and 20× speeds. It can pause and seek to any command boundary.

The first record must have index and offset zero. The final record must have kind `run.completed`, `run.failed`, or `run.cancelled`.

## Record kinds

Version 1 defines these kinds:

- `run.started`: Public run metadata and seat model identities.
- `game.event`: One authoritative `catanarchy.game-event.v1` envelope.
- `negotiation.event`: One authorized `catanarchy.negotiation-event.v1` envelope.
- `agent.requested`: Request metadata, the seat ID, and the game or negotiation sequence. The full seat observation is seat-visible, not public.
- `agent.responded`: The selected operation, reason, outcome, model identity, elapsed time, token use, and cost.
- `agent.failed`: The bounded failure category and attempt. It must not include credentials or an unbounded provider payload.
- `run.completed`: Final sequence values and result summary.
- `run.failed`: A bounded failure category and the last durable sequence values.
- `run.cancelled`: The cancellation reason and the last durable sequence values.

A game command can emit more than one game event. All events with the same `commandId` form one atomic replay batch. A viewer must reduce the complete batch before it displays the next board state.

Example timeline:

```jsonl
{"schema":"catanarchy.run-record.v1","runId":"run-42","index":0,"offsetMs":0,"recordedAt":"2026-09-10T10:00:00.000Z","kind":"run.started","visibility":"public","payload":{"matchId":"game-42","seats":["red","blue","white"]}}
{"schema":"catanarchy.run-record.v1","runId":"run-42","index":1,"offsetMs":36064,"recordedAt":"2026-09-10T10:00:36.064Z","kind":"agent.responded","visibility":"public","payload":{"seatId":"red","gameSequence":0,"outcome":"selected","elapsedMs":36064,"actionId":"settlement:v:-1:-3"}}
{"schema":"catanarchy.run-record.v1","runId":"run-42","index":2,"offsetMs":36066,"recordedAt":"2026-09-10T10:00:36.066Z","kind":"run.completed","visibility":"public","payload":{"gameSequence":1,"negotiationSequence":0,"winnerPlayerId":null}}
```

## Pi session compatibility

Catanarchy does not copy or redefine Pi's session schema. For Pi agents, it creates one persistent session per seat with the documented public call `SessionManager.create(cwd, sessionDirectory)`. Pi writes its native versioned JSONL entries. The manifest records the returned session ID and file path.

This gives each seat a session that Pi can open directly with `SessionManager.open(path)`. It also preserves Pi's normal message and tool-call structure without putting private seat messages in the public timeline.

A viewer reads Pi sessions only through a server-side projection. The projection can expose public chat, selected actions, bounded reasons, timing, and usage. It must not send hidden observations, directed messages for another seat, model reasoning, credentials, or raw provider data to a public browser.

Imported runs that have only the old result JSON cannot recover raw Pi messages or exact wall-clock timing. Their viewer uses recorded model-call durations where available and a one-second fallback for missing intervals. The UI must label that timing source.

## Validation

A reader rejects a package when:

- a schema identifier is unknown
- IDs do not agree with the manifest
- timeline indexes have a gap or duplicate
- monotonic offsets decrease
- a terminal manifest has no matching terminal record
- a game event sequence is invalid
- an atomic command batch cannot replay
- a seat session path escapes the package
- a public projection contains a seat-private record

Unknown record kinds are rejected in version 1. A later compatible addition must use a new schema identifier or an explicit extension record whose namespace is owned by its producer.

## Loading and seeking

A loader validates the manifest before it opens referenced files. It replays game events only at complete command boundaries. It builds a sparse index from timeline index and game sequence to byte offset. The viewer seeks to the nearest earlier state checkpoint and replays forward to the selected record.

Checkpoints are derived cache data. They are not authoritative and can be deleted and rebuilt from `timeline.jsonl`.

## Security and privacy

The referee package can contain all seat sessions and private observations. It is not safe to publish. Public and seat-specific bundles are generated projections with their own manifests. Redaction happens before serialization, not in browser code.

No file can contain API keys, authorization headers, environment values, or credential-store data. Provider error text is bounded and scrubbed before it enters a record.
