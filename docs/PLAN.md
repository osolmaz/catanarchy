# Implementation plan

## Goal

Catanarchy will provide a deterministic Catan simulator and a multi-agent negotiation harness built on Pi. Agents will use the same commands and observations when they play through the native simulator, Colonist, or another supported backend.

The first rules target is the current three-player and four-player CATAN base game. Expansions and house rules remain outside the first release.

## Product boundaries

The repository will keep five concerns separate.

- The protocol defines stable commands and events. It also defines observations and adapter capabilities.
- The engine owns authoritative game state and applies base-game rules.
- The harness schedules turns and negotiation rounds. It manages agents with their timeouts and traces.
- The Pi runtime gives each player an isolated model session and game-specific tools.
- Adapters translate between the protocol and external game systems.

The engine will have no Pi, browser, network, database, or model dependency. This boundary keeps batch simulation fast and makes rule tests easy to run.

## Source material

Rules work will use these sources in order:

1. [CATAN base-game rulebook](https://www.catan.com/sites/default/files/2025-03/CN3081%20CATAN%E2%80%93The%20Game%20Rulebook%20secure%20%281%29.pdf)
2. [Official base-game FAQ](https://www.catan.com/faq/basegame)
3. Focused conformance cases for rule interactions and ambiguous edge cases

Several engines were inspected for design lessons. Catanatron shows the value of exhaustive legal-action lists and batch simulation. JSettlers2 separates authoritative server state from partial client state. The TypeScript `catan-game` project separates actions, validation, state, and events. Catanarchy will implement its own code and contracts.

## Base-game rules target

### Components and board

The standard game uses 19 terrain hexes and 18 number tokens. It also uses 9 harbors, 25 development cards, plus four sets of player pieces. The terrain supply has four each of forests, pastures, and fields. It has three hills and three mountains together with one desert. Each player has 15 roads with 5 settlements and 4 cities.

The generated board must satisfy the selected setup policy. The first policy will implement the variable setup from the current rulebook. Terrain is shuffled first. Number tokens then follow their defined spiral order while skipping the desert. Harbors occupy legal coastal positions. The robber starts on the desert.

Board topology will use canonical integer identifiers. Hexes will use axial coordinates. Vertices and edges will derive from normalized lattice coordinates, so identity will not depend on insertion order or rendering geometry. Tests will assert that 19 hexes produce 54 vertices and 72 edges.

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

The reducer will fold an initial configuration and ordered events into authoritative state. Snapshots are caches and never replace the event log as the source of truth.

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

Each seat will run in a separate Pi `AgentSession`. A session receives only its current observation and legal actions. It also receives permitted messages with active offers. Private memory and the decision deadline stay scoped to that session.

The Pi integration will replace the coding system prompt and expose only game tools. Initial tools will inspect the current observation and send a message. Other tools will submit or answer an offer, choose a legal action, then finish a decision. File and shell tools will stay disabled during matches.

The harness will use documented Pi SDK APIs to create sessions with custom prompts and tools. It will also use the public subscription, cancellation, and disposal APIs. A Pi core change needs a concrete missing capability and its own plan.

Normal Pi messages and tool results form the private player-session history. The canonical match log remains separate and contains only authorized public or player-specific projections. This prevents one player’s session from becoming a source of truth for the game.

## Simulator and adapter APIs

The native simulator will provide an in-process TypeScript API and a JSON Lines process protocol. The process protocol allows Python training workers and other languages to run matches without importing TypeScript.

Every external adapter will pass the same conformance suite. It must report capabilities and create or attach to a match. It must return player observations and legal actions. It must apply commands while streaming events, then resynchronize after interruption.

The Colonist adapter will translate between observed Colonist state and canonical protocol data. It will treat Colonist as authoritative and confirm each accepted operation before advancing local state. Colonist work begins only after the native engine and adapter conformance suite are stable.

## Repository layout

The initial scaffold keeps boundaries as source directories while the contracts settle:

```text
src/
  protocol/
  engine/
  simulator/
test/
docs/
```

Later milestones add source directories for negotiation and the harness. Separate directories will hold agents and adapters. A workspace split will happen only when a boundary needs an independent build or release. The repository will remain one monorepo.

## Milestones

### Milestone 0: scaffold

- [x] Initialize the MIT TypeScript project.
- [x] Add Effect and the Pi SDK dependency.
- [x] Add strict TypeScript with Oxlint and Oxfmt.
- [x] Add Vitest together with SimpleDoc and Slophammer.
- [x] Disable mutation testing with a reason in Slophammer configuration.
- [x] Add deterministic random helpers and validated match initialization.
- [x] Add a runnable simulator entry point and CI configuration.

Completion requires `npm run simulate` and `npm run check` to pass.

### Milestone 1: board and setup

- [ ] Implement canonical coordinates for hexes and their vertices and edges.
- [ ] Generate the standard board graph and verify its counts.
- [ ] Add terrain and number-token generation.
- [ ] Add harbor and development-deck generation.
- [ ] Implement fixed and variable setup policies.
- [ ] Enumerate and apply both initial placement rounds.
- [ ] Grant second-settlement resources.
- [ ] Add property tests for board connectivity and identity stability.

Completion requires deterministic replay of complete setup for a fixed seed.

### Milestone 2: production and main turn

- [ ] Add turn phases and command legality.
- [ ] Implement dice production and bank shortages.
- [ ] Implement purchases for roads and settlements.
- [ ] Implement purchases for cities and development cards.
- [ ] Implement maritime trade rates and harbor ownership.
- [ ] Allow legal ordering between trade and build operations or card play.
- [ ] Add exhaustive legal-action generation.

Completion requires seeded games to progress from setup through repeated normal turns without manual state changes.

### Milestone 3: robber and development cards

- [ ] Implement discard queues for a seven.
- [ ] Implement robber movement with victim selection and private theft.
- [ ] Implement all development-card effects.
- [ ] Enforce purchase-turn and one-card-per-turn restrictions.
- [ ] Test finite bank and deck behavior.

Completion requires conformance tests for every robber and development-card rule listed above.

### Milestone 4: awards and victory

- [ ] Implement exact longest-route search for branches and cycles.
- [ ] Implement interruption and tie behavior.
- [ ] Implement Largest Army transfer.
- [ ] Calculate public and hidden victory points.
- [ ] End a match only when the active player meets the target.

Completion requires generated graph cases plus full-game tests with deterministic scripted agents.

### Milestone 5: domestic trade and language

- [ ] Add negotiation windows and policy limits.
- [ ] Add public and directed messages.
- [ ] Add offers and counteroffers.
- [ ] Add replies with withdrawal and expiry.
- [ ] Validate and atomically commit accepted trades.
- [ ] Record nonbinding promises and later evidence.
- [ ] Add adversarial tests for stale or conflicting offers and impossible trades.

Completion requires four scripted agents to conduct multi-round bargaining and finish a valid game.

### Milestone 6: Pi agents

- [ ] Define the seat-scoped Pi system prompt.
- [ ] Register game tools through the Pi SDK.
- [ ] Create one isolated session per seat.
- [ ] Route observations and messages without hidden-state leakage.
- [ ] Add decision deadlines with cancellation and retry.
- [ ] Add deterministic fallback behavior.
- [ ] Capture model and token data with latency, tool, and outcome traces.

Completion requires a mixed match with Pi agents and scripted agents using the same protocol.

### Milestone 7: batch simulation and training data

- [ ] Add bounded parallel match execution.
- [ ] Add seat rotation and fixed seed sets.
- [ ] Export replay bundles and player-specific training examples.
- [ ] Add resumable batch manifests without mixing partial and final results.
- [ ] Measure engine time separately from model time.
- [ ] Add benchmark reports for throughput and memory.
- [ ] Report replay stability separately.

Completion requires a repeatable batch that produces byte-stable event logs for deterministic agents.

### Milestone 8: adapters

- [ ] Publish the adapter capability contract.
- [ ] Add a fake adapter for failure and resynchronization tests.
- [ ] Add the Colonist adapter.
- [ ] Add at least one second simulator adapter to prove portability.
- [ ] Run the shared conformance suite against every adapter.

Completion requires one unchanged agent to play through the native engine and each supported adapter.

## Test strategy

Unit tests will cover rules and pure calculations. Property tests will cover graph structure and resource conservation. They will also cover piece limits and legal-action soundness against reducer invariants. Replay tests will compare complete event streams and final states for fixed inputs. Information-boundary tests will snapshot every viewer projection and search for private fields.

Scripted full-game agents will exercise the engine without model variance. Adapter conformance tests will inject disconnects and duplicate events. They will also test stale actions and rejection followed by resynchronization. Pi integration tests will use fake model streams. Live model tests will remain separate from the normal deterministic suite.

Mutation testing is excluded. Slophammer records that decision, while coverage remains at or above 85 percent and complexity remains at or below 8.

## Performance decision

TypeScript remains the engine language until measurements show a meaningful limit. Reports will separate engine execution, serialization, harness scheduling, and model inference.

A Rust replacement becomes a candidate only when engine work consumes a material share of batch runtime or blocks an agreed simulation-throughput target. The exact target will be set from the first training workload. If Rust becomes necessary, it will replace the TypeScript engine behind the protocol and conformance suite. The project will not maintain two authoritative engines.

## Initial exclusions

The first implementation excludes expansions and graphical game assets. It also excludes public matchmaking and persistent accounts. Rating systems, model training jobs, and production Colonist operation can be planned after the base engine and negotiation model pass conformance tests with the Pi session boundary.
