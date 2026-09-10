# Agent harness

## Purpose

The agent harness lets scripted agents and Pi model agents use the same game protocol. It can run a bounded number of decisions through a complete native game, including awards, victory, and optional negotiation windows.

## Module boundaries

The implementation has three modules.

- `packages/harness` schedules decisions, gives each seat an authorized observation, validates the selected action, applies the command through the engine, and reports each request, decision, negotiation event, and complete game-event batch.
- `packages/pi-agent` adapts one Pi `AgentSession` to the harness agent interface. It owns model lookup, the seat system prompt, the `choose_action` tool, timeout cancellation, usage collection, and session disposal.
- `packages/run-log` writes the harness records, run status, timing, and Pi session references to a run directory.

The engine stays deterministic and has no Pi dependency. The Pi tool selects an action but does not change game state. Only the harness can pass the selected command to the engine.

## Negotiation contract

Negotiation is a harness protocol layered over the game engine. Speech and proposals do not change authoritative game state. Only a completed `domestic-trade` engine command moves resource cards.

A negotiation window opens once when a normal turn first reaches `turn.action`. It uses these fixed bounds from its policy:

- a positive maximum round count
- one negotiation operation per seat in each round
- a maximum message length
- a maximum number of open offers

The active player acts first in each round. The other seats follow in table order. A full round of passes closes the window early. The window also closes at the round limit. Closing expires all open offers. The normal game-action decision follows the window. Builds do not reopen it during the same turn.

An agent can return one of these operations:

- pass
- send a public or directed message
- make a public or directed offer with exact give and receive bundles
- counter an open offer
- accept, reject, or withdraw an open offer
- record a nonbinding promise
- attach later evidence to a recorded promise

Every operation is decoded at the untrusted agent boundary. Offers are immutable. A counteroffer closes its parent and creates a new offer with reversed participants. Only the active turn player and one other player can be parties to an offer. Only the target can accept or reject it, and only its proposer can withdraw it.

Acceptance rechecks the offer status, game sequence, participants, and both current hands. The harness normalizes the offer into the active player's `domestic-trade` command and asks the engine to settle it. A successful settlement records the exact game-event sequence and expires all other open offers from the older game sequence. A failed or stale settlement records a failure and moves no cards.

Messages and promises have no rule effect. Each new turn window carries the prior match transcript, promises, and evidence forward. Each agent request contains the complete event history that its seat can see, but only current-window offers are actionable. Promise evidence can therefore refer to an authorized promise from an earlier turn and records a participant's note with a valid game-event sequence. It does not decide whether a promise was kept. This keeps argument and belief data available for training without making natural language authoritative.

Authoritative negotiation records use their own deterministic sequence. Each projected view renumbers its visible records from zero and reports a viewer-local cursor, so hidden directed activity does not create visible sequence gaps. Public views contain public speech, public offers, offer status changes, and completed trades. A seat view also contains directed records where that seat is the sender, recipient, proposer, or target. Other directed records are absent rather than redacted. Scoped offer, promise, and evidence IDs count only records visible in the same public or participant channel. Promises and evidence use the same scope rule. A counteroffer or promise can refer to an earlier offer only when every recipient of the new record can also see that offer.

The optional `SeatAgent.negotiate` method uses the same isolated seat instance as game decisions. Agents without this method pass. Negotiation failures, deadlines, and invalid operations become bounded pass outcomes and operational traces. They do not stop a valid game.

## Decision contract

For each decision, the harness sends an agent these values:

- match ID and event sequence
- acting player ID
- that player's `GameObservation`
- the complete legal-action list for that state
- an abort signal controlled by the decision deadline

The agent returns one legal-action ID and an optional short reason. Action IDs are opaque. The harness gives the agent deep copies of the observation and legal actions. It resolves the returned ID against a private canonical action list from the engine. It does not accept a model-written command payload or any mutation made through the agent request.

The harness creates one agent instance for each player and keeps it for the match. It disposes all created agents when the match ends or fails. Different seats never share model messages or private observations.

## Failure behavior

Each decision has a deadline and a bounded attempt count. An invalid action ID, a model failure, or a deadline expiry consumes one attempt. The harness cancels an expired attempt before it starts another attempt. Cancellation and the original decision get a one-second grace period to settle. If cancellation fails or either operation remains pending, the harness quarantines that seat agent and uses deterministic fallbacks for its remaining decisions. Agent disposal also has a one-second bound.

After all attempts fail, the harness selects the first legal action. The engine's legal-action order and the match seed make this fallback deterministic. The trace identifies the fallback and its cause. A decision with no legal actions is a harness error because it means that the engine and scheduler disagree.

The default attempt count is one. A caller must opt in to retries because every retry can spend model tokens.

## Pi session boundary

Each seat uses one in-memory Pi session. The integration uses these documented SDK APIs from `@earendil-works/pi-coding-agent` 0.85.1:

- `createAgentSession`
- `ModelRuntime`
- `SessionManager.inMemory`
- `SettingsManager.inMemory`
- `createExtensionRuntime`
- `defineTool`
- `session.prompt`, `session.abort`, and `session.dispose`

The resource loader returns no extensions, skills, prompt templates, themes, or `AGENTS.md` files. The session gets a game-specific system prompt and only the `choose_action` and `choose_negotiation` tools. Read, shell, edit, write, web, and other coding tools are disabled.

The integration does not use or change Pi internals. A normal Pi match uses `SessionManager.create(cwd, sessionDirectory)` to write one native session file for each seat. Tests and callers that do not request saved sessions still use `SessionManager.inMemory(cwd)`. Settings remain in memory. Model authentication stays in the user's existing provider stores or process environment. The harness never writes credentials to match records.

## Prompt and tool

The system prompt tells the model that it controls one Catan seat, must use only visible state, and must call the one tool for the current request exactly once. A game decision uses `choose_action`. Its prompt contains a compact JSON document derived from the seat observation. It includes:

- phase and active seat
- public player summaries
- occupied vertices and edges
- board terrain and number tokens
- legal settlement and city locations with adjacent terrain, numbers, and harbors
- legal road locations with endpoint IDs
- roll, development-card purchase, maritime trade, and end-turn actions

The game-action tool input is:

```json
{
  "actionId": "opaque legal-action ID",
  "reason": "optional short reason"
}
```

A negotiation request contains the authorized observation, complete visible negotiation transcript, current open offers, promises, evidence, and operation rules. The `choose_negotiation` tool accepts one typed operation with the fields needed for messages, offers, counteroffers, replies, withdrawal, promises, or evidence. Providers without tool-call support can return one exact `NegotiationAction` JSON object. The protocol decoder and harness validate it before it can affect the negotiation session.

The active tool validates the selection against the current request. Every call terminates the Pi turn, which limits one harness attempt to one provider generation. A valid call returns the selected action or operation. A call to the wrong tool, an invalid selection, or a duplicate call poisons the complete decision attempt and returns a terminating tool error. Text in the same response cannot recover a poisoned attempt. The harness then controls the next bounded attempt or deterministic fallback.

## Run records

The optional harness activity callback receives records in the order that they happen. It receives a seat-scoped request before each attempt, a decision after the attempt, each negotiation event, each game event, and a command-completed marker after the full event batch for one game command. The callback is awaited. A write failure stops the match instead of leaving the saved record behind the game.

The [run log format](RUN_LOG.md) adds monotonic time and writes each activity as one JSONL line. The Pi CLI enables this by default and records the path before its first model request.

## Traces

A decision trace contains:

- match ID, sequence, player ID, and attempt number
- model provider and model ID when applicable
- selected action ID
- model reason when supplied, except for private discard choices
- elapsed milliseconds
- input, output, cache, and total token counts when the runtime reports them
- reported cost when the runtime reports it
- fallback status and a sanitized failure category

A match result contains the final state, ordered engine events, and ordered decision traces. Discard action IDs use opaque per-sequence option numbers, and the harness removes the model reason for those choices. Raw provider requests, hidden authoritative state, Pi messages, and credentials are not part of the trace.

The command-line runner prints the match result summary. It writes a JSON result only when the caller supplies `--output`. Output files are operational artifacts and must not be committed by default.

## Command line

The live runner accepts model references in `provider/model-id` form:

```bash
npm run play:pi -- \
  --models=openai/gpt-5.6-luna,huggingface/deepseek-ai/DeepSeek-V4-Flash \
  --seed=42 \
  --decisions=17 \
  --timeout-ms=90000 \
  --context-window-tokens=131072 \
  --cost-ceiling-usd=5
```

Four seats receive models in round-robin order. The runner rejects unknown models and missing provider authentication before it creates a game. `--decisions` defaults to 16, which completes four-player setup. A larger value continues into normal turns and stops safely at the robber boundary. `--max-attempts` defaults to one. `--thinking` defaults to `low`. `--context-window-tokens` defaults to 131,072 and must be at least 32,768. Pi compacts long seat sessions within that limit. `--cost-ceiling-usd` defaults to $5 and applies to the complete run. `--output` is optional.

## Live-test limit

Live model tests are opt-in and are not part of `npm run check`. A normal repository check uses fake agents and makes no network request.

The default live validation is limited to one initial-placement match, 16 decisions, one attempt for each decision, 4,096 output tokens for each request, and no automatic paid retry. The output allowance gives reasoning models enough room to reach the required action. The run uses low model reasoning. Before the run, the operator must inspect model availability and pricing metadata. The high estimate uses the highest listed pricing tier, the configured context and output limits, and the fixed request count. For every normal request, it allows the original provider call, two split-turn overflow-compaction calls, one recovery retry, and two post-recovery compaction calls. If exact prices are not available, the operator must keep the run below the project's $5 fallback ceiling through the fixed request count and token limits. A higher cumulative ceiling requires direct approval. The test must stop if authentication, routing, or cost evidence differs from the approved configuration.

## Test plan

Deterministic tests cover these cases:

- one persistent agent instance for each seat
- seat-scoped observations without private opponent resources or development cards
- valid action selection and engine application
- invalid IDs, exceptions, and deadline expiry
- deterministic fallback selection
- bounded retry behavior and cancellation
- round-robin model assignment
- three-player and four-player setup completion
- bounded normal-turn, discard, robber, and development-card decisions
- public and directed negotiation projection without private-record leaks
- offer, counteroffer, reply, withdrawal, expiry, and promise records
- stale, conflicting, malformed, and impossible trade attempts
- four scripted bargaining agents that settle a trade and finish a game
- a complete deterministic game with exact event replay
- terminal games with no further agent request
- stable event and trace order
- Pi game and negotiation tool termination and usage extraction through a fake Pi session boundary

A focused live smoke test then proves that each requested model can call the tools in the real Pi SDK and that a model-driven match can reach negotiation without crossing seat boundaries.

## Live validation

The first mixed-model validation completed on 2026-09-09 with Pi SDK 0.85.1 and seed 42.

- Seats alternated between `openai/gpt-5.6-luna` through the official OpenAI provider and `huggingface/deepseek-ai/DeepSeek-V4-Flash` through Hugging Face Inference Providers.
- All 16 decisions used the terminating `choose_action` tool. No decision failed and no deterministic fallback ran.
- The final state had eight settlements, eight roads, sequence 21, and phase `turn.roll`.
- The run reported 32,489 input tokens, 11,826 output tokens, 194,326 total tokens including cache accounting, and $0.01700829 total cost.
- The output limit was 4,096 tokens. An earlier 2,048-token run needed one fallback because one DeepSeek decision did not reach its tool call before the limit.
- Model catalog revisions and the Hugging Face provider's selected serving backend were not exposed by this Pi SDK path. The run therefore records no model revision or inferred backend claim. Speculative decoding was not requested and was not reported.

The detailed result stayed outside the repository at `/tmp/catanarchy-pi-live-4096.json`. It contains no credentials. It is test evidence, not a committed benchmark artifact.

A focused negotiation validation completed on 2026-09-10 with the same Pi SDK and seed.

- All four seats used `huggingface/deepseek-ai/DeepSeek-V4-Flash` through Hugging Face Inference Providers.
- The bounded match ran 19 game decisions through setup, a seven, robber movement, one negotiation window, and the first end-turn action.
- All four negotiation decisions used `choose_negotiation` successfully. Each seat passed, so the window closed early with `all-passed`.
- No game or negotiation decision failed, and no deterministic fallback ran.
- The run reported 99,490 input tokens, 21,798 output tokens, 401,352 total tokens including cache accounting, and $0.02003204 total cost.
- The result is outside the repository at `/home/onur/scratch/catanarchy-ds4-negotiation-seed42-19.json`. It contains no credential fields.

This proves the live negotiation tool boundary. It is not a complete match or a model-quality benchmark.
