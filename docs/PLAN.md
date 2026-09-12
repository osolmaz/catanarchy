# Implementation plan

## Goal

Catanarchy will provide a deterministic Catan simulator and a multi-agent negotiation harness built on Pi. Agents will use the same commands and observations when they play through the native simulator, Colonist, or another supported backend.

The first rules target is the current three-player and four-player CATAN base game. Expansions and house rules remain outside the first release.

The current implementation covers the regular board and native base-game rules from setup through victory, atomic domestic trade, bounded negotiation, a trusted local web client, and the Pi agent harness with structured game-action and negotiation tools. Pi matches write timed run records and one native Pi session per seat. The trusted viewer can follow a running match and replay saved runs. Remote public viewing and adapters remain planned work.

## Product boundaries

The repository will keep six concerns separate.

- The protocol defines stable commands and events. It also defines observations and adapter capabilities.
- The engine owns authoritative game state and applies base-game rules.
- The harness schedules turns and negotiation rounds. It manages agents with their timeouts and traces.
- The Pi runtime gives each player an isolated model session and game-specific tools.
- Adapters translate between the protocol and external game systems.
- The web viewer renders authorized observations and projected events without running game rules.

The engine will have no Pi, browser, network, database, or model dependency. This boundary keeps batch simulation fast and makes rule tests easy to run.

## Source material

Native-engine rules work will use these sources in order:

1. [CATAN base-game rulebook](https://www.catan.com/sites/default/files/2025-03/CN3081%20CATAN%E2%80%93The%20Game%20Rulebook%20secure%20%281%29.pdf)
2. [Official base-game FAQ](https://www.catan.com/faq/basegame)
3. Focused conformance cases for rule interactions and ambiguous edge cases

The [Colonist compatibility profile](COLONIST.md) records Colonist's published rules, platform behavior, dated clarifications, and open verification work. Colonist-specific behavior belongs in that profile rather than the native base-game rules.

Several engines were inspected for design lessons. Catanatron shows the value of exhaustive legal-action lists and batch simulation. JSettlers2 separates authoritative server state from partial client state. The TypeScript `catan-game` project separates actions, validation, state, and events. Catanarchy will implement its own code and contracts.

## Base-game rules target

### Components and board

The standard game uses 19 terrain hexes and 18 number tokens. It also uses 9 harbors, 25 development cards, plus four sets of player pieces. The terrain supply has four each of forests, pastures, and fields. It has three hills and three mountains together with one desert. Each player has 15 roads with 5 settlements and 4 cities.

The generated board must satisfy the selected setup policy. The first policy will implement the variable setup from the current rulebook. Terrain is shuffled first. Number tokens then follow their defined spiral order while skipping the desert. Harbors occupy legal coastal positions. The robber starts on the desert.

The [engine design](ENGINE.md) defines the exact integer coordinate system, canonical IDs, state model, command and event flow, invariants, rule cases, test suites, and Milestone 1 merge gate. The engine supports only the regular radius-two topology during the first release.

### Initial placement

Games start with a forward placement round followed by a reverse placement round. Each placement consists of one settlement and one adjacent road. Settlements must satisfy the distance rule. The second settlement grants one resource for each adjacent producing terrain hex.

The initial starting player can be supplied by a match configuration or selected through a recorded dice procedure. The resulting order must appear in the event log.

### Turn sequence

A normal turn supports these stages:

- An eligible development card may be played before the roll.
- The active player rolls two dice.
- A normal result produces resources.
- A seven starts the discard procedure. Robber movement, victim selection, and a random steal follow.
- The active player may trade and build in the main action stage.
- The active player ends the turn.

Trade and build will share one main stage. This permits legal interleaving without inventing a strict phase boundary that the current rules do not require. Development-card timing will be checked independently because one eligible card may be played during the active player’s turn.

### Resource production

Settlements receive one matching resource and cities receive two when an adjacent unblocked number is rolled. The desert produces nothing. The robber blocks only its current hex.

The bank supply is finite. Resource-shortage behavior will have explicit conformance tests before implementation. Every transfer between bank and player will emit public and private projections that disclose only the information allowed by the rules.

### Building

The engine will implement these costs:

| Purchase         | Cost                                   |
| ---------------- | -------------------------------------- |
| Road             | 1 brick and 1 lumber                   |
| Settlement       | 1 brick, 1 lumber, 1 grain, and 1 wool |
| City             | 3 ore and 2 grain                      |
| Development card | 1 ore, 1 grain, and 1 wool             |

Roads must connect to the player’s network and occupy empty edges. Another player’s settlement or city blocks continuation through its vertex. During normal play, a settlement needs an owned connecting road and an empty vertex. Both neighboring vertices must also be empty. A city replaces one of the player’s settlements.

Piece supplies are hard limits. Costs and pieces are consumed atomically only after full validation succeeds.

### Robber and discards

When a seven is rolled, each player with more than seven resource cards discards half, rounded down. All required discards complete before the robber moves. The robber must move to another hex. If one or more opponents have a building next to that hex, the active player selects an eligible victim and steals one random resource card. The random result belongs in the event log without exposing the card to other players.

A Knight moves the robber and steals by the same procedure without causing discards.

### Development cards

The deck contains 14 Knights and 2 Road Building cards. It also contains 2 Year of Plenty cards and 2 Monopoly cards, plus 5 hidden victory-point cards. A player may buy any number they can afford. A non-victory development card cannot be played on the turn it was bought, and no more than one can be played in a turn.

The engine will model each effect as commands and events. Road Building places up to two legal roads. Year of Plenty draws up to two available resources. Monopoly transfers all cards of one named resource from opponents. Victory-point cards remain hidden until revealed to win.

### Awards and winning

Longest Road requires a continuous route of at least five roads. The route calculation must handle branches and cycles as well as interruptions by an opponent. It must also handle ties and loss of the current award. Largest Army starts at three played Knights and moves only to a player with a strictly larger army.

Settlements give one victory point. Cities, Longest Road, and Largest Army give two each. Hidden victory-point cards give one each. A player wins immediately when they have at least ten victory points during their own turn.

## Protocol design

### Commands

A command states one requested operation. Commands will use stable string tags and engine-independent identifiers. The first set will cover setup placement and dice. It will then cover discards with the robber procedure, all building operations, bank trade, development cards, domestic trade, plus turn completion.

Each request will include its match and command IDs. It will identify the acting player and expected event sequence. The sequence check prevents stale agents and external adapters from applying an action to the wrong state.

### Events

Events are the permanent record of accepted state changes. Each event will contain a schema identifier and sequence number. It will also contain an event type with its data. Random outcomes will be stored directly in events. Replay will not regenerate them.

The reducer will fold an initial `game.created` event and all following events into authoritative state. That first event contains the validated configuration and complete initialized game data, so the event log is self-contained. The reduced state stores its latest sequence but not its event history. The match store owns the append-only event log. Snapshots are caches and never replace that log as the source of truth.

### Observations

The engine will derive observations from authoritative state for a named viewer. Supported viewers will include players and public spectators. A trusted referee view will expose full state. The player projection can include that player’s resource cards and development cards. Opponent hands expose counts and public cards only.

Legal actions will be generated from the same player projection and authoritative state. Agents will select from stable action IDs. They will never construct unvalidated engine calls.

### Failures

Expected failures will use typed Effect errors. The protocol will distinguish malformed input, stale sequence, unknown match, wrong phase, wrong player, insufficient resources, occupied location, disconnected route, distance-rule failure, unavailable card, and expired trade.

A rejected command does not change state, consume randomness, or append a game event. The harness may record a separate attempt trace for diagnostics.

## Negotiation

Free-form language and binding operations will remain separate. An agent can send an argument and submit a structured offer in one response, but the text cannot transfer resources.

The negotiation model will support public and directed messages. Offers can target one or more opponents and can receive a counteroffer. Players can accept, reject, withdraw, or let an offer expire. The active player must be one side of every base-game domestic trade. A valid trade transfers resource cards in both directions. Gifts and like-for-like exchanges are rejected. Triangular transfers are also rejected.

Promises about later turns are social commitments. The harness will record the text and claimed parties along with timing and later evidence. The base-game engine will not enforce them. This includes promises about the robber or future building, as well as voting, retaliation, or avoidance.

A match policy will limit message count and negotiation rounds. It will also limit elapsed time and model tokens. These limits belong to the harness configuration and will be present in training traces.

## Pi agent runtime

The [agent harness design](AGENT_HARNESS.md) defines the module boundaries, decision contract, failure behavior, Pi SDK surface, traces, command line, live-test limit, and deterministic test plan.

Each seat will run in a separate Pi `AgentSession`. A session receives only its current observation and legal actions. It also receives permitted messages with active offers. Private memory and the decision deadline stay scoped to that session.

The Pi integration will replace the coding system prompt and expose only game tools. Initial tools will inspect the current observation and send a message. Other tools will submit or answer an offer, choose a legal action, then finish a decision. File and shell tools will stay disabled during matches.

The harness will use documented Pi SDK APIs to create sessions with custom prompts and tools. It will also use the public subscription, cancellation, and disposal APIs. A Pi core change needs a concrete missing capability and its own plan.

Normal Pi messages and tool results form the private player-session history. The access-controlled authoritative match log remains separate and contains the private events required for exact replay. Public and seat-specific training traces receive only authorized projections. A player session never becomes a source of truth for the game.

## Simulator and adapter APIs

The native simulator will provide an in-process TypeScript API and a JSON Lines process protocol. The process protocol allows Python training workers and other languages to run matches without importing TypeScript.

Every external adapter will pass the same conformance suite. It must report capabilities and create or attach to a match. It must return player observations and legal actions. It must apply commands while streaming events, then resynchronize after interruption.

The Colonist adapter will translate between observed Colonist state and canonical protocol data. It will treat Colonist as authoritative and confirm each accepted operation before advancing local state. Colonist work begins only after the native engine and adapter conformance suite are stable.

## Repository layout

The repository keeps protocol, engine, and application boundaries in one root TypeScript project:

```text
packages/
  protocol/src/
  engine/src/
apps/
  cli/src/
  web/src/
test/
  engine/
  web/
docs/
```

Later milestones add modules for negotiation, the harness, agents, and adapters. One root package controls dependencies and checks until a module needs independent publishing or release settings. The repository remains one monorepo.

## Milestones

### Milestone 0: scaffold

- [x] Initialize the MIT TypeScript project.
- [x] Add Effect and record the Pi SDK as a later integration boundary.
- [x] Add strict TypeScript with Oxlint and Oxfmt.
- [x] Add Vitest together with SimpleDoc and Slophammer.
- [x] Disable mutation testing with a reason in Slophammer configuration.
- [x] Add deterministic random helpers and validated match initialization.
- [x] Add a runnable simulator entry point and CI configuration.

Completion requires `npm run simulate` and `npm run check` to pass.

### Milestone 1: board and setup

The [engine design](ENGINE.md) is the detailed contract for this milestone.

- [x] Add integer coordinates and stable topology IDs.
- [x] Generate the regular 19-hex graph and pass every topology invariant.
- [x] Generate terrain and the official number-token spiral from a labeled random stream.
- [x] Place the standard nine-harbor pattern on the coastal ring and shuffle harbor kinds.
- [x] Separate the event store from reduced game state and add exact replay.
- [x] Implement the forward and reverse initial-placement state machine.
- [x] Grant second-settlement resources as part of the accepted placement batch.
- [x] Generate canonical legal actions and seat-scoped observations.
- [x] Add topology, layout, rule, replay, invariant, and privacy tests.

A scripted three-player or four-player game now completes setup through legal action IDs and replays to the same state. The remaining base-game rules start in Milestone 2.

### Milestone 2: production and main turn

The [Milestone 2 engine contract](ENGINE.md#milestone-2-contract) locks the phases, dice and shortage behavior, costs, placement rules, maritime rates, commands, events, legal actions, privacy boundary, and tests before implementation.

- [x] Add turn phases and command legality.
- [x] Implement dice production and bank shortages.
- [x] Implement purchases for roads and settlements.
- [x] Implement purchases for cities and development cards.
- [x] Implement maritime trade rates and harbor ownership.
- [x] Allow legal ordering between trade and build operations.
- [x] Add exhaustive legal-action generation.

Seeded games now progress from setup through normal turns without manual state changes.

### Milestone 3: robber and development cards

The [Milestone 3 engine contract](ENGINE.md#milestone-3-contract) locks discard execution, robber continuations, deterministic theft, development-card timing and effects, finite supplies, privacy, and tests before implementation.

- [x] Implement discard queues for a seven.
- [x] Implement robber movement with victim selection and private theft.
- [x] Implement all action development-card effects and preserve hidden Victory Point cards for Milestone 4.
- [x] Enforce purchase-turn and one-card-per-turn restrictions.
- [x] Test finite bank and deck behavior.

Conformance tests cover the robber and development-card rules in the Milestone 3 contract.

### Milestone 4: awards and victory

The [Milestone 4 engine contract](ENGINE.md#milestone-4-contract) defines exact road search, award ties, visible and hidden scoring, derived events, terminal state, privacy, and tests before implementation.

- [x] Implement exact longest-route search for branches and cycles.
- [x] Implement interruption and tie behavior.
- [x] Implement Largest Army transfer.
- [x] Calculate public and hidden victory points.
- [x] End a match only when the active player meets the target.

Generated graph cases and a full deterministic harness game test verify completion.

### Milestone 5: web viewer

The [web viewer design](VIEWER.md) is the detailed contract for this milestone.

- [x] Add the viewer-safe observation schema.
- [x] Create the Vite React application.
- [x] Render the regular board as layered SVG with canonical topology IDs.
- [x] Add local accepted-command history navigation and event inspection.
- [x] Add public player summaries and active-seat resource display for local hot-seat play.
- [x] Add trusted local report replay at atomic command boundaries with timed controls.
- [ ] Add viewer-safe saved replay package loading from the run log format.
- [x] Stream trusted local run records through HTTP and server-sent events.
- [x] Reconnect and reload when the live sequence has a gap.
- [ ] Add remote privacy, accessibility, and visual regression tests.

The first viewer slice is a trusted local setup client. The full milestone will load viewer-safe saved replays and live streams without authoritative state in the browser.

### Milestone 6: domestic trade and language

The [domestic-trade engine contract](ENGINE.md#milestone-6-domestic-trade-contract), [negotiation harness contract](AGENT_HARNESS.md#negotiation-contract), and [negotiation viewer design](VIEWER.md#step-6-negotiation-views) lock this milestone before implementation.

- [x] Add one bounded negotiation window when a turn first reaches the action phase.
- [x] Add public and directed messages.
- [x] Add immutable offers and counteroffers between the active player and one other seat.
- [x] Add acceptance, rejection, withdrawal, stale-offer expiry, and window expiry.
- [x] Validate and atomically commit accepted trades through one engine command.
- [x] Record nonbinding promises and participant-supplied later evidence.
- [x] Extend the web timeline with scope-safe message and offer views.
- [x] Add adversarial tests for stale or conflicting offers and impossible trades.

Completion requires four scripted agents to conduct multi-round bargaining and finish a valid game. The viewer must show the resulting public and seat-specific negotiations without private-data leaks.

### Milestone 7: Pi agents

The Pi adapter connects isolated model sessions to normal game decisions and the negotiation protocol while preserving the harness clock, fallback, trace, and information boundaries. It follows the same exploration and finalization pattern as pi-reviewer. A seat can use several model messages and read-only inspection calls before it commits one engine action.

- [x] Define the seat-scoped Pi system prompt.
- [x] Register the terminating `choose_action` tool through the Pi SDK.
- [x] Create one isolated session per seat.
- [x] Route observations without hidden-state leakage.
- [x] Add decision deadlines with cancellation and bounded retry.
- [x] Add deterministic fallback behavior.
- [x] Capture model and token data with latency, tool, and outcome traces.
- [x] Run an opt-in mixed-model initial-placement smoke test.
- [x] Route negotiation messages and offers through a structured Pi tool.
- [x] Add a read-only state inspection tool that can be called several times before selection.
- [x] Share one exploration clock across all messages and action decisions in a player turn.
- [x] Warn the model while turn time remains, then disable inspection and request an immediate action.
- [x] Give a nonselecting model the finalization grace period before the harness applies a legal fallback.
- [x] Use the configured context window and the model's effective output capacity by default. Keep an explicit output cap as an operator override rather than a low harness default.
- [x] Count planning messages, finalization, compaction, and recovery in the launch cost bound.
- [x] Scale Pi compaction history to the effective context window.
- [x] Clear pending time warnings when a selection or planning limit ends the model turn.
- [x] Give each seat a 10-minute shared exploration window and a 60-second finalization window.
- [x] Test multi-message turns, clock rollover, finalization, fallback, hidden-state isolation, and legal engine application.
- [x] Run an opt-in DS4 test through setup and the first normal turns without token-limit failures.

Acceptance requires at least one test turn with several assistant messages before selection, no applied illegal command, no hidden-state leak, and no fallback caused by a harness output cap. The turn clock must reset only when the game turn changes. Setup placement pairs use one shared setup clock. The model can inspect and reason until the exploration clock or planning-message limit ends. Finalization then allows only the action tool for a separate grace period.

The web viewer must be able to follow the match without access to Pi session state.

### Milestone 8: portable replay and board provenance

Saved model games must remain useful when the native board generator changes. Adapters must also be able to replay a valid board observed from Colonist without pretending that Catanarchy generated it from a seed.

The complete `GameState` inside the first `game.created` event will become the authoritative replay starting point. Replay will decode that state, check its invariants, and then apply every later atomic event batch. A separate native verifier will reconstruct commands and compare their events. Replay will not regenerate the starting board with the current generator.

This change separates four questions:

1. Is the stored starting state structurally valid?
2. Can the event reducer apply every later atomic batch while preserving engine invariants?
3. For a native match, does command re-decision reproduce every later event exactly?
4. Does the current native generator produce the same starting state from the recorded seed?

The first two questions decide whether a log can be replayed. The last two produce verification and provenance information for native evaluations and the viewer. A mismatch with the current generator does not by itself make a valid stored game unreadable.

#### Scope

- [x] Update the locked replay decision in [Engine design](ENGINE.md) before changing code.
- [x] Add a complete runtime schema for `GameState` and the full `game.created` payload.
- [x] Split starting-state loading and event reduction from native game generation.
- [x] Make replay initialize from the decoded `game.created` state.
- [x] Run the full engine invariant suite on the starting state and after each applied atomic batch.
- [x] Keep exact command re-decision and event-batch comparison as a native-match verifier.
- [x] Let adapter matches use the same reducer while reporting that native command reproduction does not apply.
- [x] Separate the recorded initial-board origin from game rules and players. An observed origin has an adapter ID and no fake generation seed.
- [x] Add a run-manifest origin field for a native generated board or an adapter-observed board.
- [x] Record the native generator identifier and seed for generated boards.
- [x] Calculate whether a native starting state matches the current generator and expose that result to the trusted viewer.
- [x] Keep the stored origin as a provenance claim. Do not present it as proof against deliberate file editing.
- [x] Update run-log validation so it uses the same starting-state decoder and invariant checks as engine replay.
- [x] Update the viewer to show board origin and current-generator match status without blocking replay.

The run manifest will use one origin union in its existing `v1` contract:

```ts
type InitialStateOrigin =
  | {
      readonly type: "generated";
      readonly generatorId: string;
      readonly seed: number;
    }
  | {
      readonly type: "observed";
      readonly adapterId: string;
    };
```

`generatorId` names the exact board-generation recipe, not the package release. `adapterId` names the adapter that observed the board. Credentials, external account IDs, and private service data do not belong in this field.

The reader calculates separate results for generation and command verification:

```ts
type GeneratorMatch = "matches-current" | "differs-from-current" | "not-applicable" | "pending";
type CommandVerification = "exact" | "not-applicable" | "pending";
```

These values are derived when a run is read. They are not stored as authoritative data because the verifier can improve and the current generator can change. Native runs require `exact` command verification for evaluation use. Adapter runs use event reduction, invariant checks, and adapter evidence instead of claiming that Catanarchy produced external random outcomes.

#### State validation

The starting-state validator will check at least:

- the schema ID, match ID, sequence zero, and `game.created` envelope
- the canonical regular topology and every referenced topology ID
- terrain, number-token, harbor, development-card, bank, and piece supplies
- the desert, robber, token, harbor, occupancy, player, phase, score, and award invariants
- random-stream labels and cursor values needed for later commands
- empty initial occupancy, initial player holdings, and the initial-placement phase
- consistency between the state, its config, and the run manifest

Generator policy and state validity stay separate. A valid board can differ from the current shuffle while still passing state invariants. A board produced by a known engine defect remains invalid. The current scratch runs used the incorrect harbor phase and can be discarded rather than adding an exception for them.

Replay and verification also stay separate. Replay reduces validated events from the stored starting state. The native verifier reconstructs commands and compares the events that the engine would produce, including random outcomes. An adapter verifier cannot honestly make that claim for dice or theft controlled by an external service. It records the adapter evidence and checks canonical transitions without labeling them as native reproduction.

#### Non-goals

This milestone will not retain the old board generator, add a fallback replay path, trust an unvalidated stored state, weaken later command checks, migrate the current scratch runs, or add cryptographic proof of who created a run. Public replay projection and long-term artifact signing remain separate work.

#### Implementation order

1. Commit the board orientation and harbor-phase correction as its own change.
2. Update `ENGINE.md` with the new replay rule and the boundary between state validity and generator matching.
3. Add the full state decoder and focused decoder tests.
4. Extract an invariant-checked event reducer and initialize it from the stored state.
5. Move command re-decision into the native verifier and remove board regeneration from replay.
6. Keep externally controlled random outcomes in the adapter conformance contract instead of inventing native generator data for observed games.
7. Add generated and observed origin data to the run manifest in place.
8. Add generator and command-verification results as report data.
9. Show origin and verification status in the trusted viewer.
10. Update old fixtures or remove scratch-only fixtures that came from the invalid harbor generator.
11. Run all engine, run-log, viewer, property, and full-project checks.

#### Acceptance criteria

- A current native game replays to the same final state and passes exact command verification.
- A valid stored starting state with a different shuffle replays without the old generator code.
- A valid adapter-observed regular board replays with an observed manifest origin and no generation seed in that origin.
- A malformed or invariant-breaking starting state is rejected before later events run.
- A changed, missing, reordered, or illegal later event batch is rejected.
- A changed native random outcome fails exact command verification.
- A generated run reports whether it matches the current generator.
- An observed run reports generator and native command verification as `not-applicable`.
- The viewer clearly separates replay validity, board origin, command verification, and current-generator matching.
- Generated and observed games use one state-loading and event-reduction path.

Focused verification will include:

```text
npx vitest run test/engine/replay.test.ts test/engine/invariants.test.ts
npx vitest run test/run-log test/web
npm run typecheck
npm run lint
npm run docs:check
npm run check
```

Implementation is complete only when the focused cases and the full project check pass from a clean working tree.

### Milestone 9: batch simulation and training data

- [ ] Add bounded parallel match execution.
- [ ] Add seat rotation and fixed seed sets.
- [x] Specify the append-only run package, exact timing, privacy scopes, and native Pi session files.
- [x] Save run records while each match is in progress.
- [x] Mark stopped, failed, cancelled, and completed runs clearly.
- [x] Add resume support for a stopped match. The implementation contract is `docs/RESUME.md`.
- [ ] Export viewer-safe replay bundles and player-specific training examples.
- [ ] Add resumable batch manifests without mixing partial and final results.
- [ ] Measure engine time separately from model time.
- [ ] Add benchmark reports for throughput and memory.
- [ ] Report replay stability separately.

Completion requires a repeatable batch that produces byte-stable event logs for deterministic agents.

### Milestone 10: adapters

- [ ] Publish the adapter capability contract.
- [ ] Add a fake adapter for failure and resynchronization tests.
- [ ] Add the Colonist adapter.
- [ ] Add at least one second simulator adapter to prove portability.
- [ ] Run the shared conformance suite against every adapter.
- [ ] Verify that adapter matches use the same viewer protocol.

Completion requires one unchanged agent to play through the native engine and each supported adapter. The same web viewer must display each backend without backend-specific rendering code.

## Test strategy

The [engine design](ENGINE.md) defines the Milestone 1 test files, mathematical topology checks, generated layout checks, exhaustive legal-action checks, replay cases, state invariants, privacy checks, and rule traceability matrix. The [web viewer design](VIEWER.md) defines geometry, component, replay, live transport, browser privacy, accessibility, and visual tests.

Unit tests will cover rules and pure calculations. Property tests will cover graph structure and resource conservation. They will also cover piece limits and legal-action soundness against reducer invariants. Replay tests will compare complete event streams and final states for fixed inputs. Information-boundary tests will snapshot every viewer projection and search for private fields.

Scripted full-game agents will exercise the engine without model variance. Adapter conformance tests will inject disconnects and duplicate events. They will also test stale actions and rejection followed by resynchronization. Pi integration tests will use fake model streams. Live model tests will remain separate from the normal deterministic suite.

Mutation testing is excluded. Slophammer records that decision, while coverage remains at or above 85 percent and complexity remains at or below 8.

## Performance decision

TypeScript remains the engine language until measurements show a meaningful limit. Reports will separate engine execution, serialization, harness scheduling, and model inference.

A Rust replacement becomes a candidate only when engine work consumes a material share of batch runtime or blocks an agreed simulation-throughput target. The exact target will be set from the first training workload. If Rust becomes necessary, it will replace the TypeScript engine behind the protocol and conformance suite. The project will not maintain two authoritative engines.

## Initial exclusions

The first implementation excludes expansions and copied graphical game assets. It also excludes public matchmaking and persistent accounts. Rating systems, model training jobs, and production Colonist operation can be planned after the base engine and negotiation model pass conformance tests with the Pi session boundary.
