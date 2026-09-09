# Engine design

## Status

The standard board and initial-placement engine are implemented. The engine generates the regular topology and a seeded layout, creates the development deck, applies initial settlements and roads in forward and reverse player order, grants starting resources, lists legal actions, projects observations, and replays accepted events.

The test suite checks topology, 1,000 generated layouts, deterministic random streams, setup rules for three and four players, replay, invariants, failures, legal actions, and private-state boundaries. Normal turns begin in Milestone 2 of the [implementation plan](PLAN.md). Colonist-specific evidence remains in the [Colonist compatibility profile](COLONIST.md).

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

Harbor positions belong to `BoardLayout`, not `StandardTopology`. This lets a native game shuffle harbor kinds and lets an adapter report an observed regular board without changing graph identity.

The headless board uses the standard nine-harbor attachment pattern on its ordered 30-edge coastal ring. The clockwise gaps between harbor edges are six gaps of three edges and three gaps of four edges. The pattern repeats `3, 4, 3` three times. A seeded rotation removes dependence on an arbitrary first coastal edge, and a separate shuffle assigns the four generic and five resource harbor kinds. Tests check the exact gap multiset, distinct coastal edges, and harbor supply for 1,000 seeds. A graphical frame is presentation data and does not enter the engine topology.

### Layout state

The persistent layout shape is:

```ts
interface BoardLayout {
  readonly topology: "standard-radius-2";
  readonly terrain: ReadonlyArray<TerrainPlacement>;
  readonly numbers: ReadonlyArray<NumberPlacement>;
  readonly harbors: ReadonlyArray<HarborPlacement>;
  readonly robberHexId: HexId;
}
```

Placements and harbors use canonical order. Native layouts come from the deterministic generator. Future adapters must decode external layout data at their boundary, then run cross-field engine invariants.

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
  readonly topology: StandardTopology;
  readonly layout: BoardLayout;
  readonly occupancy: BoardOccupancy;
  readonly bank: ResourceCounts;
  readonly players: ReadonlyArray<PlayerState>;
  readonly developmentDeck: ReadonlyArray<DevelopmentCard>;
  readonly phase: SetupPhase;
  readonly random: RandomCursors;
}
```

The state does not contain its event history. The local caller owns the append-only event log. A snapshot contains `GameState` at a known sequence and can be replaced by replay at any time. A durable match store will be added with the harness.

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
  readonly value: number;
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

Milestone 1 adds `place-initial-settlement` and `place-initial-road`. Effect Schema decodes the version, match identity, actor, sequence, and tagged payload before command dispatch.

`matchId` rejects cross-match routing mistakes, and `expectedSequence` rejects stale work. A future durable event store will keep a command-ID index so a retry can return its original result without applying the command twice.

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

Effect Schema decodes an event envelope and its tagged payload before replay reads it. Authoritative events do not contain wall-clock time. Operational traces can record receipt and completion times outside the deterministic log.

Initial event types are:

- `game.created`
- `settlement.placed`
- `initial-resources.granted`
- `road.placed`
- `initial-placement.completed`

`game.created` is the first event at sequence zero. Its payload contains the validated configuration, complete layout, hidden development-deck order, initial placement phase, and random cursors after initialization. This one complete event prevents a replay from exposing a partly initialized state. For the current native schema, replay regenerates this first state and requires an exact match before it accepts later events.

Private event data stays in the access-controlled authoritative log. Public and seat-specific traces receive redacted projections.

### Engine functions

The engine exposes small functions with clear roles. An accepted command returns a non-empty event batch:

```ts
type EventBatch = readonly [GameEvent, ...ReadonlyArray<GameEvent>];

createGame(config): Effect<CommandResult, RuleViolation>
decide(state, command): Effect<EventBatch, RuleViolation>
applyEvent(state, event): GameState
handleCommand(state, command): Effect<CommandResult, RuleViolation>
replay(events): Effect<GameState, ReplayViolation>
legalActions(state): ReadonlyArray<LegalAction>
observe(state, viewer): GameObservation
checkInvariants(state): ReadonlyArray<string>
```

`createGame` validates the configuration, draws the initial random values, and emits `game.created` with the first complete state. `decide` decodes and checks one command, including its match ID, then returns domain events. `applyEvent` applies one accepted event without input or randomness. `handleCommand` calls `decide` and `applyEvent` in order. `replay` regenerates and checks `game.created`. It then reconstructs each command, runs the same rule decision, and requires the recorded event batch to match exactly before applying it. `checkInvariants` is available to tests and optional debug builds.

## Randomness

The engine uses labeled random streams so a change in one procedure does not alter unrelated future results. The initial labels are:

- `board`
- `development-deck`
- `dice`
- `resource-steal`

Each stream has a fixed algorithm version and cursor. For a bound `n`, bounded integer selection computes `limit = floor(2^32 / n) * n`, draws unsigned 32-bit values until one is below `limit`, then returns `value % n`. This rejection step removes modulo bias. Shuffles use Fisher-Yates with this bounded integer function.

Random values are consumed only while deciding an accepted random operation. The emitted event stores the outcome and updated cursor. Rejected commands cannot move a cursor.

Changing a random algorithm is a protocol change because it affects seed reproducibility. The current replay validator supports its registered algorithm and schema version. Preserving older logs after an algorithm change requires keeping the matching versioned initializer or migrating those logs explicitly.

## Legal actions and observations

Legal actions come from the same rule predicates used by command validation. The engine must not maintain a second independent set of placement rules.

During an initial settlement phase, the engine considers every standard vertex and returns each vertex that is empty and has no occupied adjacent vertex. During the following road phase, it considers only unoccupied edges incident to the recorded settlement.

Each legal action has a stable action ID and a complete canonical command payload. An agent selects an offered action ID. The harness resolves it to the command, adds the current sequence, then submits it. The engine still validates the command because an adapter or concurrent client can become stale.

Observations expose the complete public board and the viewer's private data. Opponent resource and development cards appear only as counts allowed by the rules. The authoritative state and private event payloads are never passed to a player agent.

## Correctness strategy

No implementation process can guarantee that the engine contains no mistake. Catanarchy uses independent checks so one coding error is unlikely to survive every layer.

Expected values must not come from the production helper under test. Topology tests use mathematical identities and a small reviewed fixture. Rule scenarios cite the rule source and state the expected result directly. Generated tests then cover combinations that examples miss.

### Test files

Milestone 1 uses these focused suites:

```text
test/engine/topology.test.ts
test/engine/layout.test.ts
test/engine/game.test.ts
test/engine/errors.test.ts
test/engine/random.test.ts
test/engine/invariants.test.ts
test/engine/protocol.test.ts
test/web/app.test.tsx
```

Vitest is the test runner. Fast-check supplies generated seeds and setup paths. Table-driven tests cover malformed commands and replay logs. Mutation testing remains excluded.

### Topology tests

Topology tests cover every invariant in the topology table. They also verify:

- Every listed neighbor points back to the source object.
- Every hex ring has six unique vertices in canonical order.
- Consecutive hex vertices resolve to the listed edge.
- Each internal edge has two adjacent hexes.
- Each coastal edge has one adjacent hex.
- Walking the coastal ring returns to its start after 30 unique edges.
- Repeated generation produces the same canonical topology.

The SVG board provides a second, visual check of the generated topology. The rendered image is a debugging aid and does not become a rule oracle or game asset. The full replay and live interface follows the separate [web viewer design](VIEWER.md).

### Layout tests

Layout tests verify each terrain, token, and harbor supply against direct expected values. They check that the desert has no number and holds the initial robber. They verify the A-to-R token order along the selected spiral while skipping the desert.

Property tests run 1,000 generated seeds in CI. Every generated layout must pass all layout invariants. Fixed-seed equality checks deterministic output. A test does not require two different seeds to produce different layouts because a random mapping can have valid collisions.

Harbor tests check nine distinct coastal attachments, the standard six three-edge gaps and three four-edge gaps, the exact harbor-kind supply, and deterministic placement.

### Placement tests

Table-driven setup tests cover three-player and four-player turn order. They include the transition where the last player starts the reverse round and the transition where the first player starts the normal game.

Rule cases cover settlement distance and edge occupancy. They also cover road anchoring and second-settlement production. Wrong-player and wrong-phase commands must fail with stable typed error codes.

At each sampled setup state, a soundness test submits every listed legal action and expects success. A completeness test considers all 54 vertices or all 72 edges and verifies that every accepted candidate was listed. This catches disagreement between legal-action generation and command validation.

### Replay and transaction tests

Replay tests compare live handling with reduction of the emitted event stream. Both paths produce equal canonical state.

The suites also verify:

- Event sequences are contiguous.
- Replays reject a missing or misplaced `game.created` event.
- Stale commands fail before the caller receives events or a replacement state.
- Wrong-player, wrong-phase, unknown-location, occupied-location, distance, and road-anchor errors have stable codes.
- Resuming from every accepted-command prefix reaches the same final setup state and event stream.

Command-ID deduplication and durable atomic appends belong to the future match store. Setup commands do not draw random values.

### State invariant tests

`checkInvariants` runs after every accepted event batch in generated command sequences. It checks:

- Occupancy uniqueness and settlement distance
- Setup road anchoring
- Non-negative resources and resource-card conservation
- Building and road limits together with active-player bounds
- Setup road-anchor phase requirements

The production path can enable invariant checks in development and conformance runs. Release batch simulation can disable repeated checks after the same command paths have passed the suite.

### Observation tests

Observation tests compare the public projection with an active-player projection after setup. The active player receives their resource values. Public output contains only each player's resource and development-card counts, and serialized public output contains no development deck.

Development-card draw work must extend these tests with distinctive private hands before that feature can merge.

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

Complete. The engine generates stable coordinate-based IDs, canonical indexes, and the standard graph. The invariant suite checks the full topology.

### Step 2: standard layout

Complete. The engine generates terrain, number tokens, harbors, and the development deck from labeled random streams. The first `game.created` event contains the complete state needed for exact replay.

### Step 3: event-state cutover

Complete. Commands produce ordered events, reducers produce state, and the event log stays outside `GameState`. Replay checks its initial event and contiguous sequence numbers.

### Step 4: initial placement

Complete. Tagged phases enforce settlement distance, road anchoring, forward and reverse order, and second-settlement resources for three-player and four-player games.

### Step 5: legal actions and observations

Complete for setup. Stable action IDs cover each legal settlement or road. Public observations hide resource identities and the development deck. Player observations reveal only that player's resources.

## Merge gate

Milestone 1 is complete only when:

- Every rule case in this document has a passing test.
- The topology, layout, and development-deck invariants pass.
- Generated setup tests pass for three-player and four-player games.
- Legal-action soundness and completeness pass.
- Replay and prefix-resume tests pass.
- Serialized observation tests find no private-state leak.
- `npm run check` passes with the configured coverage and complexity limits.
- A manual browser smoke test confirms the rendered topology, harbor positions, and setup controls.

The merge gate provides strong evidence. It does not replace later live Colonist conformance tests or the full-game rule suites in later milestones.
