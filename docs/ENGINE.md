# Engine design

## Status

The board and rules engine are not implemented yet. The current scaffold validates a match configuration and supplies seeded random values. It creates a small initial state with two startup events. Its tests cover only that scaffold.

This document is the implementation contract for the standard board and initial-placement milestone. The broader sequence remains in the [implementation plan](PLAN.md). Colonist-specific evidence remains in the [Colonist compatibility profile](COLONIST.md).

## Scope

The first engine supports the regular three-player and four-player base-game board. The board always has the standard radius-two land topology. Arbitrary maps and map editing are outside this scope. Expansions and the larger topology are also outside this scope.

A standard topology can have different layouts. The layout contains terrain and number tokens. It also contains harbors and the robber location. Roads and buildings belong to the changing game position. This separation lets native games generate a regular random layout while an adapter supplies a layout observed from Colonist.

The first native layout policy is the official variable setup. A reviewed fixed layout can exist as a test fixture, but the engine does not need a general setup-policy plug-in system during this milestone.

## Design rules

The engine follows these rules:

- All rule calculations are deterministic and independent from Pi.
- Persistent protocol data uses simple JSON values and plain records.
- Game calculations do not use rendering coordinates or floating-point geometry.
- A command requests a change. Events record accepted changes. A reducer applies them.
- The authoritative event log remains separate from the reduced game state.
- Random outcomes appear in events, so replay does not draw random values again.
- Expected failures use typed Effect errors. Ordinary calculations remain plain pure functions.
- Derived values are calculated from source data unless history is necessary to resolve a rule.
- Player observations are projections. They never receive the authoritative private state.

A rejected command leaves state unchanged. It produces no game event and consumes no random value.

## Standard topology

### Hex coordinates

Each land hex uses an axial coordinate `(q, r)`. The implied cube coordinate is `s = -q - r`. A hex belongs to the regular board when:

```text
max(abs(q), abs(r), abs(q + r)) <= 2
```

This rule produces exactly 19 hexes. The stable identifier is:

```text
h:<q>:<r>
```

The six axial neighbor offsets are:

```text
( 1,  0)
( 1, -1)
( 0, -1)
(-1,  0)
(-1,  1)
( 0,  1)
```

The generator sorts hexes by `r` and then `q`. Array insertion order must not define identity.

### Vertex coordinates

Vertices use a separate integer lattice. For a hex at `(q, r)`, its lattice center is:

```text
centerX = 3q
centerY = 2r + q
```

The six corner offsets, in canonical ring order, are:

```text
( 2,  0)
( 1,  1)
(-1,  1)
(-2,  0)
(-1, -1)
( 1, -1)
```

Adding the offsets to the center gives the six vertex coordinates. Positive `y` points down in the canonical board orientation, so the listed corner order is clockwise. Adjacent hexes produce identical coordinates for a shared vertex. The engine therefore deduplicates vertices by coordinate without tolerances or rounding.

The stable identifier is:

```text
v:<x>:<y>
```

Vertices sort by `y` and then `x`. A renderer can transform these lattice values into pixels, but that transform does not enter the engine.

### Edge identifiers

Each pair of consecutive corners on a hex creates an undirected edge. The two endpoint vertices are ordered with the numeric vertex comparator before the identifier is built:

```text
e:<first-vertex-id>|<second-vertex-id>
```

The engine must not order signed coordinates with raw string comparison. Numeric ordering prevents unstable results around negative values.

Edges sort by their ordered endpoint coordinates. Deduplication by endpoint pair produces one edge shared by adjacent hexes.

The coastal ring starts at the boundary vertex that sorts first by `y` and then `x`. That vertex has two boundary neighbors. The traversal selects the neighbor that sorts first, then follows the only unused boundary edge until it returns to the start. This rule gives the 30 coastal edges one stable order.

### Topology data

The generated topology has this logical shape:

```ts
interface StandardTopology {
  readonly schema: "catanarchy.standard-topology.v1";
  readonly hexes: ReadonlyArray<TopologyHex>;
  readonly vertices: ReadonlyArray<TopologyVertex>;
  readonly edges: ReadonlyArray<TopologyEdge>;
  readonly coastalRing: ReadonlyArray<EdgeId>;
}

interface TopologyHex {
  readonly id: HexId;
  readonly q: number;
  readonly r: number;
  readonly vertexIds: readonly [VertexId, VertexId, VertexId, VertexId, VertexId, VertexId];
  readonly edgeIds: readonly [EdgeId, EdgeId, EdgeId, EdgeId, EdgeId, EdgeId];
  readonly neighborHexIds: ReadonlyArray<HexId>;
}

interface TopologyVertex {
  readonly id: VertexId;
  readonly x: number;
  readonly y: number;
  readonly adjacentHexIds: ReadonlyArray<HexId>;
  readonly adjacentVertexIds: ReadonlyArray<VertexId>;
  readonly edgeIds: ReadonlyArray<EdgeId>;
}

interface TopologyEdge {
  readonly id: EdgeId;
  readonly vertexIds: readonly [VertexId, VertexId];
  readonly adjacentHexIds: ReadonlyArray<HexId>;
}
```

The serialized form uses sorted arrays. Runtime code can build private `ReadonlyMap` indexes for fast lookup. Maps and caches do not enter protocol events or replay bundles.

### Required topology invariants

The generated graph must satisfy all of these checks:

| Check                                  | Expected result |
| -------------------------------------- | --------------: |
| Hex count                              |              19 |
| Vertex count                           |              54 |
| Edge count                             |              72 |
| Coastal edges                          |              30 |
| Internal edges                         |              42 |
| Vertices with graph degree 2           |              18 |
| Vertices with graph degree 3           |              36 |
| Vertices adjacent to 1 hex             |              18 |
| Vertices adjacent to 2 hexes           |              12 |
| Vertices adjacent to 3 hexes           |              24 |
| Euler value `vertices - edges + hexes` |               1 |

Every hex has six distinct vertices and edges. Every edge has two distinct endpoints and one or two adjacent hexes. All adjacency relations are symmetric. The vertex graph is connected. The 30 coastal edges form one closed ring.

## Board layout

### Terrain

The layout assigns one terrain to each hex:

| Terrain  | Resource | Count |
| -------- | -------- | ----: |
| Forest   | Lumber   |     4 |
| Pasture  | Wool     |     4 |
| Field    | Grain    |     4 |
| Hill     | Brick    |     3 |
| Mountain | Ore      |     3 |
| Desert   | None     |     1 |

The protocol uses the terrain tags `forest`, `pasture`, `field`, `hill`, `mountain`, and `desert`. Resource records use `lumber`, `wool`, `grain`, `brick`, and `ore`.

### Number tokens

The desert has no number token. The other 18 hexes receive this official A-to-R sequence:

```text
5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11
```

The variable setup places the sequence counterclockwise in a spiral from a selected corner while skipping the desert. The selected corner and all other random choices come from the board-layout random stream and appear in the initial `game.created` event.

The number-token multiset is:

| Number | Count |
| -----: | ----: |
|      2 |     1 |
|      3 |     2 |
|      4 |     2 |
|      5 |     2 |
|      6 |     2 |
|      8 |     2 |
|      9 |     2 |
|     10 |     2 |
|     11 |     2 |
|     12 |     1 |

A layout contains no token numbered seven.

### Harbors

A harbor placement contains a coastal edge and a harbor kind:

```ts
interface HarborPlacement {
  readonly edgeId: EdgeId;
  readonly kind: "generic" | Resource;
}
```

The standard supply has four generic 3:1 harbors and one 2:1 harbor for each of the five resources. All nine harbor edges must be distinct coastal edges.

Harbor positions belong to `BoardLayout`, not `StandardTopology`. This supports the shuffled standard frame and lets an adapter report the regular Colonist board without changing graph identity.

The exact native harbor-position procedure must come from a reviewed representation of the official six frame pieces. The implementation must not invent a spacing rule from a screenshot. A fixed fixture must identify each frame segment, its allowed joins, and its harbor attachment edges. Tests then project a shuffled frame onto the ordered coastal ring.

### Layout state

The persistent layout shape is:

```ts
interface BoardLayout {
  readonly topology: "standard-radius-2";
  readonly terrainByHex: ReadonlyArray<readonly [HexId, Terrain]>;
  readonly numberByHex: ReadonlyArray<readonly [HexId, NumberToken]>;
  readonly harbors: ReadonlyArray<HarborPlacement>;
  readonly robberHexId: HexId;
}
```

Pairs and harbors use canonical order. Effect Schema validates all external layout data. Engine invariants then validate cross-field rules that a field schema cannot express.

### Development deck initialization

Game initialization also shuffles the 25-card development deck. The supply contains 14 Knight cards, 2 Road Building cards, 2 Year of Plenty cards, 2 Monopoly cards, and 5 victory-point cards. The deck uses its own labeled random stream, so board-generator changes cannot alter card order.

The authoritative state stores the complete hidden order. The initial `game.created` event records that order in its private payload. Player and public projections never expose cards that have not been drawn or revealed.

Tests verify the exact card supply, deterministic order for a fixed seed, independence from the board stream, and full preservation through event replay.

## Changing position

Board occupancy is separate from the layout:

```ts
interface BoardOccupancy {
  readonly buildings: ReadonlyArray<Building>;
  readonly roads: ReadonlyArray<Road>;
}

interface Building {
  readonly vertexId: VertexId;
  readonly playerId: PlayerId;
  readonly kind: "settlement" | "city";
}

interface Road {
  readonly edgeId: EdgeId;
  readonly playerId: PlayerId;
}
```

There can be at most one building on a vertex and one road on an edge. Remaining pieces derive from occupancy and the standard player supply. A city replaces a settlement, so the replaced settlement becomes available again. The state must not keep a second mutable piece counter that can disagree with occupancy.

## Authoritative game state

The authoritative state contains the latest reduced facts:

```ts
interface GameState {
  readonly schema: "catanarchy.game-state.v1";
  readonly matchId: MatchId;
  readonly sequence: number;
  readonly config: GameConfig;
  readonly layout: BoardLayout;
  readonly occupancy: BoardOccupancy;
  readonly bank: ResourceCounts;
  readonly players: ReadonlyArray<PlayerState>;
  readonly developmentDeck: ReadonlyArray<DevelopmentCard>;
  readonly phase: GamePhase;
  readonly awards: AwardState;
  readonly random: RandomCursors;
}
```

The state does not contain its event history. The match store owns the append-only event log. A snapshot contains `GameState` at a known sequence and can be replaced by replay at any time.

The current scaffold stores events inside `GameState`. Milestone 1 removes that field before the state becomes a public contract.

Resource counts and supporting state use fixed records:

```ts
interface ResourceCounts {
  readonly lumber: number;
  readonly brick: number;
  readonly wool: number;
  readonly grain: number;
  readonly ore: number;
}

interface PlayerState {
  readonly id: PlayerId;
  readonly resources: ResourceCounts;
  readonly developmentCards: ReadonlyArray<DevelopmentCard>;
  readonly playedKnights: number;
}

interface AwardState {
  readonly longestRoadPlayerId: PlayerId | null;
  readonly largestArmyPlayerId: PlayerId | null;
}

interface RandomCursor {
  readonly algorithm: "catanarchy-prng-v1";
  readonly state: number;
  readonly draws: number;
}

interface RandomCursors {
  readonly board: RandomCursor;
  readonly developmentDeck: RandomCursor;
  readonly dice: RandomCursor;
  readonly resourceSteal: RandomCursor;
}
```

The random state is an unsigned 32-bit integer and `draws` is a non-negative safe integer. Stream seeds come from the root match seed, a stable label-to-seed function, and published test vectors. Adding a new label cannot change an existing stream.

All resource counts are non-negative integers. The bank and all player hands together preserve the resource-card supply unless an initialization event establishes a different profile.

Values such as legal actions and visible victory points derive from state. Award ownership remains in state because a tie can depend on the previous holder. Random cursors remain in state so a replayed match can continue with the same future random stream.

## Initial-placement state machine

Milestone 1 implements these phases:

```ts
type SetupPhase =
  | {
      readonly tag: "setup.settlement";
      readonly direction: "forward" | "reverse";
      readonly playerIndex: number;
    }
  | {
      readonly tag: "setup.road";
      readonly direction: "forward" | "reverse";
      readonly playerIndex: number;
      readonly settlementId: VertexId;
    }
  | {
      readonly tag: "turn.roll";
      readonly playerIndex: number;
      readonly turn: 1;
    };
```

A settlement phase can accept only an initial-settlement command from the named player. A successful settlement moves to a road phase and records the new settlement as the required road anchor. A road phase accepts only an unoccupied edge incident to that anchor.

After the last forward road, the same last player starts the reverse settlement round. After each reverse road, the player index decreases. After the first player's reverse road, setup completes and the first normal turn starts with that player.

Placing a reverse-round settlement also grants one resource for every adjacent producing terrain hex. The command emits the placement and private resource-grant events as one accepted event batch. A desert produces nothing.

Tagged phases make incomplete combinations difficult to represent. There is no optional pending settlement in phases where it has no meaning.

## Commands, events, and replay

### Commands

Each command envelope includes:

```ts
interface CommandEnvelope<TCommand> {
  readonly schema: "catanarchy.command.v1";
  readonly matchId: MatchId;
  readonly commandId: CommandId;
  readonly playerId: PlayerId;
  readonly expectedSequence: number;
  readonly command: TCommand;
}
```

Milestone 1 adds `place-initial-settlement` and `place-initial-road`. IDs use Effect Schema brands at TypeScript boundaries and validated strings in serialized data.

The match runtime serializes commands for one match. `expectedSequence` rejects stale work. The event store keeps a command-ID index so a retry can return its original result without applying the command twice.

### Events

Each event envelope includes:

```ts
interface EventEnvelope<TEvent> {
  readonly schema: "catanarchy.game-event.v1";
  readonly matchId: MatchId;
  readonly sequence: number;
  readonly commandId: CommandId;
  readonly event: TEvent;
}
```

Authoritative events do not contain wall-clock time. Operational traces can record receipt and completion times outside the deterministic log.

Initial event types are:

- `game.created`
- `settlement.placed`
- `initial-resources.granted`
- `road.placed`
- `initial-placement.completed`
- `turn.started`

`game.created` is the first event at sequence zero. Its payload contains the validated configuration, complete layout, hidden development-deck order, initial placement phase, and random cursors after initialization. This one complete event prevents a replay from exposing a partly initialized state. Replay applies its recorded outcomes and does not shuffle again.

Private event data stays in the access-controlled authoritative log. Public and seat-specific traces receive redacted projections.

### Engine functions

The engine exposes small functions with clear roles. An accepted command returns a non-empty event batch:

```ts
type EventBatch = readonly [GameEvent, ...ReadonlyArray<GameEvent>];

initialize(config): Effect<HandleResult, RuleViolation>
start(event: GameCreatedEvent): GameState
decide(state, command): Effect<EventBatch, RuleViolation>
evolve(state, event: GameEventAfterCreation): GameState
handle(state, command): Effect<HandleResult, RuleViolation>
replay(events): Effect<GameState, ReplayViolation>
legalActions(state, playerId): ReadonlyArray<LegalAction>
observe(state, viewer): Observation
checkInvariants(state): ReadonlyArray<InvariantViolation>
```

`initialize` validates the configuration, draws the initial random values, emits `game.created`, and calls `start` to produce the first complete state. `decide` checks a command and returns domain events. `evolve` applies one later accepted event without input or randomness. `handle` calls `decide` and `evolve` in order. `replay` requires `game.created` first, calls `start` once, then validates and applies the remaining contiguous events. `checkInvariants` is available to tests and optional debug builds.

## Randomness

The engine uses labeled random streams so a change in one procedure does not alter unrelated future results. The initial labels are:

- `board`
- `development-deck`
- `dice`
- `resource-steal`

Each stream has a fixed algorithm version and cursor. For a bound `n`, bounded integer selection computes `limit = floor(2^32 / n) * n`, draws unsigned 32-bit values until one is below `limit`, then returns `value % n`. This rejection step removes modulo bias. Shuffles use Fisher-Yates with this bounded integer function.

Random values are consumed only while deciding an accepted random operation. The emitted event stores the outcome and updated cursor. Rejected commands cannot move a cursor.

Changing a random algorithm is a protocol change because it affects seed reproducibility. Event replay remains stable because recorded outcomes do not depend on the new implementation.

## Legal actions and observations

Legal actions come from the same rule predicates used by command validation. The engine must not maintain a second independent set of placement rules.

During an initial settlement phase, the engine considers every standard vertex and returns each vertex that is empty and has no occupied adjacent vertex. During the following road phase, it considers only unoccupied edges incident to the recorded settlement.

Each legal action has a stable action ID and a complete canonical command payload. An agent selects an offered action ID. The harness resolves it to the command, adds the current sequence, then submits it. The engine still validates the command because an adapter or concurrent client can become stale.

Observations expose the complete public board and the viewer's private data. Opponent resource and development cards appear only as counts allowed by the rules. The authoritative state and private event payloads are never passed to a player agent.

## Correctness strategy

No implementation process can guarantee that the engine contains no mistake. Catanarchy uses independent checks so one coding error is unlikely to survive every layer.

Expected values must not come from the production helper under test. Topology tests use mathematical identities and a small reviewed fixture. Rule scenarios cite the rule source and state the expected result directly. Generated tests then cover combinations that examples miss.

### Test files

Milestone 1 adds these focused suites:

```text
test/engine/topology.test.ts
test/engine/layout.test.ts
test/engine/layout.property.test.ts
test/engine/development-deck.test.ts
test/engine/setup.test.ts
test/engine/legal-actions.test.ts
test/engine/replay.test.ts
test/engine/invariants.property.test.ts
test/engine/observations.test.ts
test/fixtures/standard-board.v1.json
```

Vitest remains the test runner. Fast-check supplies generated inputs for seeds and command sequences. It also supplies malformed boundary data. Mutation testing remains excluded.

### Topology tests

Topology tests cover every invariant in the topology table. They also verify:

- Every listed neighbor points back to the source object.
- Every hex ring has six unique vertices in canonical order.
- Consecutive hex vertices resolve to the listed edge.
- Each internal edge has two adjacent hexes.
- Each coastal edge has one adjacent hex.
- Walking the coastal ring returns to its start after 30 unique edges.
- Reversing generator insertion order produces byte-identical serialized topology.
- The generated topology matches the reviewed standard-board fixture.

A diagnostic renderer can produce an SVG from topology data for human inspection. The generated image is a debugging aid and does not become a rule oracle or game asset. The full replay and live interface follows the separate [web viewer design](VIEWER.md).

### Layout tests

Layout tests verify each terrain, token, and harbor supply against direct expected values. They check that the desert has no number and holds the initial robber. They verify the A-to-R token order along the selected spiral while skipping the desert.

Property tests run at least 1,000 generated seeds in CI. Every generated layout must pass all layout invariants. A fixed seed has a checked JSON fixture and stable hash. A test must not require two different seeds to produce different layouts because a random mapping can have valid collisions.

Harbor tests use the reviewed frame fixture. They check every legal frame join and require nine distinct coastal attachments. Separate assertions check the harbor-kind supply and deterministic projection onto the coastal ring.

### Placement tests

Table-driven setup tests cover three-player and four-player turn order. They include the transition where the last player starts the reverse round and the transition where the first player starts the normal game.

Rule cases cover settlement distance and edge occupancy. They also cover road anchoring and second-settlement production. Wrong-player and wrong-phase commands must fail with stable typed error codes.

At each sampled setup state, a soundness test submits every listed legal action and expects success. A completeness test considers all 54 vertices or all 72 edges and verifies that every accepted candidate was listed. This catches disagreement between legal-action generation and command validation.

### Replay and transaction tests

Replay tests compare live handling with reduction of the emitted event stream. Both paths must produce byte-identical canonical state. Serialization between each event must not change the result.

The suites also verify:

- Event sequences are contiguous.
- A stale expected sequence changes no state.
- A repeated command ID returns the stored result only once.
- A failed command emits no event.
- A failed command consumes no random value.
- A multi-event command is appended atomically.
- Truncating the log at any committed batch boundary gives the expected valid intermediate state.
- Resuming from every committed prefix reaches the same final setup state.

### State invariant tests

`checkInvariants` runs after every accepted event batch in generated command sequences. It checks:

- Occupancy uniqueness and settlement distance
- Setup road anchoring
- Non-negative resources and card conservation
- Piece limits and active-player bounds
- Phase requirements and event sequence agreement

The production path can enable invariant checks in development and conformance runs. Release batch simulation can disable repeated checks after the same command paths have passed the suite.

### Observation tests

Observation tests build states with distinctive private card values for every player. Each player projection must contain that player's private values and only permitted counts for opponents. Public projections contain no private card identities.

The tests inspect serialized output rather than only TypeScript fields. This catches leaks introduced by schema encoders or JSON conversion.

### Rule traceability

Every rule scenario uses a stable case ID and cites a source section. The first matrix is:

| Case           | Requirement                                                | Primary source                                     |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `BOARD-001`    | Use the standard 19-hex base board                         | CATAN rulebook, components and setup               |
| `BOARD-002`    | Put no number token on the desert                          | CATAN rulebook, variable setup                     |
| `BOARD-003`    | Start the robber on the desert                             | CATAN rulebook, setup                              |
| `DECK-001`     | Initialize the exact 25-card development deck              | CATAN rulebook, components                         |
| `SETUP-001`    | Place once in forward order and once in reverse order      | CATAN rulebook, variable setup round 1 and round 2 |
| `SETUP-002`    | Keep settlements at least two edges apart                  | CATAN rulebook, starting pieces                    |
| `SETUP-003`    | Connect each initial road to its settlement                | CATAN rulebook, starting pieces                    |
| `SETUP-004`    | Grant resources around the second settlement               | CATAN rulebook, starting resources                 |
| `COLONIST-001` | Use the same core rules for the normal four-player profile | Colonist compatibility profile                     |

A rule change must update its scenario or add a new one. An unclear rule remains an open case and does not become guessed behavior.

## Implementation sequence

### Step 1: identifiers and topology

Add branded coordinate and ID schemas. Generate the standard graph and canonical indexes. Add the topology fixture and invariant suite.

Completion requires all topology checks to pass from different generator insertion orders.

### Step 2: standard layout

Add terrain and number-token generation with the labeled board stream. Add the reviewed frame representation and harbor projection. Initialize the development deck from its independent stream. Emit the complete layout and private deck order in the first `game.created` event.

Completion requires at least 1,000 generated seeds, the fixed-seed fixture, and development-deck checks to pass every invariant.

### Step 3: event-state cutover

Remove the event array from `GameState`. Add command and event envelopes, the reducer, replay validation, and atomic handling. Preserve the existing schema identifier and replace the scaffold contract in place.

Completion requires replay from each valid event prefix and exact continuation from its random cursors.

### Step 4: initial placement

Implement the tagged setup phases and placement events. Add distance, occupancy, road-anchor, turn-order, and starting-resource rules.

Completion requires scripted legal play to finish setup for three-player and four-player games.

### Step 5: legal actions and observations

Generate stable legal actions and seat-scoped observations. Add exhaustive soundness and completeness checks together with serialized privacy tests.

Completion requires a scripted agent to use observations and action IDs only, complete setup, save the event log, then replay it to the same state.

## Merge gate

Milestone 1 is complete only when:

- Every rule case in this document has a passing test.
- The topology, layout, and development-deck invariants pass.
- Generated setup tests pass for three-player and four-player games.
- Legal-action soundness and completeness pass.
- Replay and prefix-resume tests pass.
- Serialized observation tests find no private-state leak.
- `npm run check` passes with the configured coverage and complexity limits.
- A manual review confirms the harbor frame fixture against the official diagram.

The merge gate provides strong evidence. It does not replace later live Colonist conformance tests or the full-game rule suites in later milestones.
