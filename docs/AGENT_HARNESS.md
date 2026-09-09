# Agent harness

## Purpose

The agent harness lets scripted agents and Pi model agents use the same game protocol. The first implementation drives the initial-placement phase that the native engine supports now. It does not claim to play a complete Catan game. Normal turns and negotiation will use the same boundary after the engine implements them.

## Module boundaries

The implementation has two modules.

- `packages/harness` schedules decisions, gives each seat an authorized observation, validates the selected action, applies the command through the engine, and records a trace.
- `packages/pi-agent` adapts one Pi `AgentSession` to the harness agent interface. It owns model lookup, the seat system prompt, the `choose_action` tool, timeout cancellation, usage collection, and session disposal.

The engine stays deterministic and has no Pi dependency. The Pi tool selects an action but does not change game state. Only the harness can pass the selected command to the engine.

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

Each decision has a deadline and a bounded attempt count. An invalid action ID, a model failure, or a deadline expiry consumes one attempt. The harness cancels an expired attempt before it starts another attempt.

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
- `session.prompt`, `session.subscribe`, `session.abort`, and `session.dispose`

The resource loader returns no extensions, skills, prompt templates, themes, or `AGENTS.md` files. The session gets a game-specific system prompt and only the `choose_action` tool. Read, shell, edit, write, web, and other coding tools are disabled.

The integration does not use or change Pi internals. It does not write normal Pi session files or settings. Model authentication stays in the user's existing provider stores or process environment. The harness never writes credentials to match traces.

## Prompt and tool

The system prompt tells the model that it controls one Catan seat, must use only visible state, and must call `choose_action` exactly once. The decision prompt contains a compact JSON document derived from the seat observation. It includes:

- phase and active seat
- public player summaries
- occupied vertices and edges
- board terrain and number tokens
- legal settlement locations with adjacent terrain, numbers, and harbors
- legal road locations with endpoint IDs

The tool input is:

```json
{
  "actionId": "opaque legal-action ID",
  "reason": "optional short reason"
}
```

The tool validates the ID against the current decision. Every call terminates the Pi turn, which limits one harness attempt to one provider generation. A valid call returns the selected action. An invalid or duplicate call returns a tool error, and the harness controls the next bounded attempt or deterministic fallback.

## Traces

A decision trace contains:

- match ID, sequence, player ID, and attempt number
- model provider and model ID when applicable
- selected action ID
- model reason when supplied
- elapsed milliseconds
- input, output, cache, and total token counts when the runtime reports them
- reported cost when the runtime reports it
- fallback status and a sanitized failure category

A match result contains the final state, ordered engine events, and ordered decision traces. Raw provider requests, hidden authoritative state, Pi messages, and credentials are not part of the trace.

The command-line runner prints the match result summary. It writes a JSON result only when the caller supplies `--output`. Output files are operational artifacts and must not be committed by default.

## Command line

The live runner accepts model references in `provider/model-id` form:

```bash
npm run play:pi -- \
  --models=openai-codex/gpt-5.6-luna,huggingface/deepseek-ai/DeepSeek-V4-Flash \
  --seed=42 \
  --timeout-ms=90000
```

Four seats receive models in round-robin order. The runner rejects unknown models and missing provider authentication before it creates a game. `--max-attempts` defaults to one. `--output` is optional.

## Live-test limit

Live model tests are opt-in and are not part of `npm run check`. A normal repository check uses fake agents and makes no network request.

The first live validation is limited to one initial-placement match, 16 decisions, one attempt for each decision, 4,096 output tokens for each request, and no automatic paid retry. The output allowance gives reasoning models enough room to reach the required action. The run uses low model reasoning. Before the run, the operator must inspect model availability and pricing metadata. The high estimate uses the highest listed pricing tier and charges the full input bound once as uncached input, once as cache reads, and once as cache writes. If exact prices are not available, the operator must keep the run below the project's $5 fallback ceiling through the fixed request count and conservative token limits. The test must stop if authentication, routing, or cost evidence differs from the approved configuration.

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
- stable event and trace order
- Pi tool termination and usage extraction through a fake Pi session boundary

A focused live smoke test then proves that each requested model can call the game tool in the real Pi SDK and that a mixed-model setup match reaches `turn.roll`.

## Live validation

The first mixed-model validation completed on 2026-09-09 with Pi SDK 0.85.1 and seed 42.

- Seats alternated between `openai/gpt-5.6-luna` through the official OpenAI provider and `huggingface/deepseek-ai/DeepSeek-V4-Flash` through Hugging Face Inference Providers.
- All 16 decisions used the terminating `choose_action` tool. No decision failed and no deterministic fallback ran.
- The final state had eight settlements, eight roads, sequence 21, and phase `turn.roll`.
- The run reported 32,489 input tokens, 11,826 output tokens, 194,326 total tokens including cache accounting, and $0.01700829 total cost.
- The output limit was 4,096 tokens. An earlier 2,048-token run needed one fallback because one DeepSeek decision did not reach its tool call before the limit.
- Model catalog revisions and the Hugging Face provider's selected serving backend were not exposed by this Pi SDK path. The run therefore records no model revision or inferred backend claim. Speculative decoding was not requested and was not reported.

The detailed result stayed outside the repository at `/tmp/catanarchy-pi-live-4096.json`. It contains no credentials. It is test evidence, not a committed benchmark artifact.
