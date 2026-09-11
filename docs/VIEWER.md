# Web viewer design

## Status

The first web slice is implemented as a trusted local game client. It starts seeded three-player and four-player games, renders the standard board, submits commands to the native engine, shows public scores, award progress, and the active player's private state, and moves through accepted-command history. It supports native games from setup through a terminal winner.

A trusted local report mode can load a Pi CLI result selected through `CATANARCHY_RUN_FILE`. It validates and replays authoritative game events at complete command boundaries. It shows the board, negotiation timeline, and saved model-call traces for the selected frame. Controls support first, previous, play, pause, next, last, and selectable playback speeds from 1× through 1000×. Old reports use recorded model-call durations and a one-second fallback because they do not contain exact chronological offsets. Raw Pi session messages are not present because those match sessions were ephemeral and were disposed.

New Pi runs use the [run log format](RUN_LOG.md). The harness writes exact timing, game events, negotiation events, model requests, and decisions while the match runs. Pi writes one native session file for each seat. The trusted local viewer follows new records through server-sent events, reconnects after a dropped stream, and reloads when it finds a sequence gap. It can download each seat's Pi session.

A public or player-specific remote viewer still needs a server-side privacy filter. The current run viewer is a trusted local tool and can read referee records. Replay and live modes cannot send game commands. The local hot-seat client remains a separate trusted mode.

## Goals

The viewer must help people:

- Inspect the standard board and verify geometry
- Watch agents play a live match
- Read public chat and trade offers in sequence
- Pause and inspect a saved match at any accepted command
- Compare the public view with one authorized player's view
- Diagnose replay and integration errors

The viewer also helps engine development. A wrong edge, harbor, road, or settlement is easier to find on a board than in serialized state.

## Scope

The first release supports the regular three-player and four-player base-game board defined in the [engine design](ENGINE.md). The web viewer uses Colonist terrain, robber, road, settlement, and city art listed in [Third-party assets](../THIRD_PARTY_ASSETS.md). It draws compact number tokens, the layered coast, intersections, piers, and harbor boats as semantic SVG elements. The engine and agent protocol do not depend on viewer art.

The current slice includes native setup, dice rolls, building, development cards, maritime and domestic trade, negotiation, discards, robber choices, awards, scores, and victory. It excludes remote commands, matchmaking, accounts, ratings, map editing, and expansion layouts. It also excludes public access to referee state.

## Boundary

The planned remote viewer consumes viewer-safe protocol data. It does not import authoritative engine state or run game rules.

```text
engine or adapter
      |
      v
observation projector
      |
      +---- saved viewer replay
      |
      +---- live viewer stream
                 |
                 v
          web viewer reducer
                 |
                 v
             React UI
```

The engine decides what is public or private before remote serialization. The browser cannot request hidden cards merely by changing a React property or URL query.

The current local game client imports the native engine and keeps authoritative state in browser memory. It asks the engine for legal actions and submits selected commands. It does not reimplement game rules. This mode is suitable only for trusted local hot-seat play and development. It must not become the transport for agent matches or remote spectators.

## Repository layout

The repository uses this module layout:

```text
apps/
  cli/src/
  web/src/
packages/
  engine/src/
  harness/src/
  pi-agent/src/
  protocol/src/
  run-log/src/
test/
  engine/
  web/
```

One root package controls dependencies and quality checks. TypeScript and Vite aliases preserve explicit protocol and engine imports without separate package release settings.

The web application uses React, Vite, strict TypeScript, Effect, Oxlint, and Oxfmt. SVG renders the board. A canvas or WebGL renderer adds complexity without helping this small fixed board.

## Viewer protocol

### Viewer identity

Every viewer request has one authorized scope:

```ts
type ViewerScope =
  | { readonly type: "public" }
  | { readonly type: "player"; readonly playerId: PlayerId }
  | { readonly type: "referee" };
```

The production service derives this scope from server-side authorization. It does not trust a scope sent by the browser. Referee scope is available only in protected development and administration environments.

### Viewer frame

The server or replay exporter produces complete frames after accepted command batches:

```ts
interface ViewerFrame {
  readonly schema: "catanarchy.viewer-frame.v1";
  readonly matchId: MatchId;
  readonly frameSequence: number;
  readonly gameSequence: number;
  readonly observation: Observation;
  readonly entries: ReadonlyArray<ProjectedTimelineEntry>;
}
```

`frameSequence` increments for each viewer-visible timeline update, including chat and offer changes that do not alter game state. It is contiguous within one authorized scope. Different scopes can have different frame sequences, so omitted private activity does not create a visible gap or reveal that hidden activity occurred. `gameSequence` is the latest authoritative game-event sequence and can stay unchanged across those frames. Engine commands use only `gameSequence` for stale-state protection.

A frame contains the observation after its timeline entries. The observation is complete for that viewer scope. This design keeps the browser simple and prevents drift between a browser reducer and the authoritative engine.

Repeated observations cost little for a base-game board and compress well over HTTP. If replay size later becomes material, the format can add periodic frames with deltas after measurement. The first implementation favors correctness.

### Replay bundle

A saved replay has this shape:

```ts
interface ViewerReplay {
  readonly schema: "catanarchy.viewer-replay.v1";
  readonly matchId: MatchId;
  readonly scope: ViewerScopeDescription;
  readonly topology: StandardTopology;
  readonly players: ReadonlyArray<PublicPlayer>;
  readonly frames: ReadonlyArray<ViewerFrame>;
  readonly result: MatchResult | null;
}
```

`ViewerScopeDescription` states what the file contains without granting access to more data. Loading a public replay can never expose a player or referee frame.

Frames use ascending unique frame sequences and non-decreasing game sequences. The first frame contains the initialized board. The final frame contains the latest accepted state or final result. Effect Schema validates the complete bundle before the UI renders it.

A canonical authoritative event log is not a viewer replay. Replay export projects and redacts authoritative data for one scope.

## Board rendering

### Coordinate transform

The viewer uses the engine's integer vertex lattice. The lattice has flat-top hexes in vertical columns. The viewer rotates it a quarter turn so the screen shows pointy-top hexes in horizontal rows of 3, 4, 5, 4, 3, the same as the physical board and Colonist. For vertex `(x, y)` and visual hex radius `scale`, the SVG coordinates are:

```text
screenX = originX - scale * sqrt(3) * y / 2
screenY = originY + scale * x / 2
```

The transform is a rotation, not a mirror, so the counterclockwise number-token spiral stays counterclockwise on screen. The viewer calculates a padded `viewBox` from the transformed topology bounds. Window size changes the rendered SVG size, not the underlying coordinates.

Hex polygons use the six vertex IDs supplied by topology. The viewer does not recompute corner identity. Roads use edge endpoints. Buildings use vertex coordinates. This keeps every rendered piece attached to the same canonical IDs used by the engine.

### Layers

The SVG uses a fixed back-to-front layer order:

1. Terrain hexes
2. Number tokens and robber
3. Harbor marks and ratios
4. Roads
5. Settlements and cities
6. Selection or diagnostic overlays

Stable element IDs include the canonical topology ID. Tests and browser inspection can therefore identify a specific topology element.

### Terrain and pieces

Terrain uses distinct colors together with labels or patterns. Color alone must not carry the meaning. Number tokens show both the number and probability pips. Six and eight use an additional visual emphasis.

Roads and buildings use player colors with a contrasting outline. A settlement and city have different original geometric shapes. The robber uses a simple original marker. Harbors show `3:1` or the resource type with `2:1`.

No renderer decision changes game state. Animations and highlights are temporary UI state.

### Diagnostic mode

Development builds can show:

- Canonical topology IDs
- Axial and lattice coordinates
- Adjacency highlights
- Coastal-ring order
- Harbor attachment edges
- Legal-action overlays supplied by an authorized observation

Diagnostic mode is off by default. It uses the same topology and frame as the normal board.

## Page layout

The desktop viewer fits one screen without page scrolling:

- SVG board in the left pane, sized to the available height
- One control strip under the board with step buttons, a frame scrubber, the frame position, and playback speed
- One sidebar with the phase line, match ID, game sequence, the player table, and one chronological feed

The feed shows the newest record first, so the latest decision, message, or binding trade is visible without scrolling. Only the feed scrolls. There is no page header, navigation bar, or section heading; the player table and the feed are self-describing. Connection and projection status join the sidebar when live transport exists.

A narrow screen stacks these regions and lets the page scroll. The board stays first. Long feeds use virtualized lists only after measured size requires them.

## Replay behavior

The replay controller holds UI state separate from match data:

```ts
interface ReplayControllerState {
  readonly frameIndex: number;
  readonly playing: boolean;
  readonly speed: 0.25 | 0.5 | 1 | 2 | 4;
  readonly followLive: boolean;
}
```

Controls support:

- First and last frame
- Previous and next timeline frame
- Play and pause
- Playback speed
- Jump to a frame sequence
- Follow or leave the live edge

Changing the selected frame reads its complete observation. It does not reverse engine events. This avoids a second reverse reducer and makes arbitrary seeking exact.

The URL can record the match ID and selected frame sequence. It must not contain private cards, access tokens, chat text, or a serialized observation.

## Live transport

The first live transport uses HTTP for the latest authorized frame and server-sent events for updates. The viewer is read-only, so it does not need a bidirectional WebSocket.

The stream follows these rules:

- Each message contains one validated `ViewerFrame`.
- The SSE event ID is `frameSequence`.
- Duplicate or older frame sequences are ignored.
- A frame-sequence gap triggers a latest-frame fetch and resynchronization.
- Reconnection sends the last accepted frame sequence when the transport supports it.
- A terminal frame closes follow-live mode cleanly.

Connection errors remain visible without clearing the last valid board. Invalid data does not partially update the page. Effect decodes the complete frame first, then the viewer replaces its current observation atomically.

The exact URL paths belong to the harness HTTP API and will be fixed when that server is implemented. The viewer contract depends on frames rather than one URL layout.

## Chat and trade timeline

Projected communication events appear in one ordered timeline with game events. The timeline distinguishes:

- Public messages
- Directed messages visible to the current scope
- New trade offers
- Counteroffers
- Accept, reject, withdraw, and expire outcomes
- Completed resource transfers
- Unenforced promises recorded as speech

The UI never presents a promise as a completed trade. A completed trade requires a projected authoritative transfer event.

A public replay excludes directed messages that were not public. A player replay includes only messages visible to that seat. Referee data stays in a separately authorized replay.

## Privacy

Privacy enforcement occurs before viewer data reaches the browser. Client-side hiding is only presentation and never counts as access control.

Tests must prove that:

- Public frames contain no resource-card identities for any player.
- A player frame contains private cards only for that player.
- Hidden development cards do not appear in public or opponent data.
- Directed messages appear only for authorized participants and referee scope.
- Hidden authoritative events never enter browser logs or error reports.
- Changing routes or local UI state cannot increase viewer scope.

The browser must not cache private replay data in persistent storage by default. A user can explicitly download an authorized replay. Access tokens stay in secure transport mechanisms and never enter URLs or replay files.

## Accessibility

The viewer supports keyboard control for replay navigation: arrow keys step frames, Home and End jump to the first and last frame, and space toggles playback. Buttons have visible focus states and accessible names. Playback does not start automatically.

The SVG has an accessible match summary outside the graphic. Important status does not depend on color, animation, or hover. Animations respect reduced-motion preferences. Player colors use labels or shapes where confusion is possible.

Number tokens, roads, buildings, and harbors have accessible names that include their canonical location. Diagnostic identifiers remain selectable as text in the event inspector.

## Failure handling

The viewer distinguishes these states:

- Replay file rejected before rendering
- Live connection interrupted with the last frame retained
- Sequence gap followed by resynchronization
- Match unavailable or access denied
- Unsupported schema
- Valid match with no new frame yet

Errors use plain messages and stable diagnostic codes. The UI does not invent missing events or advance either sequence after a decode failure.

## Tests

### Geometry tests

Unit tests cover the lattice-to-SVG transform and view-box bounds. Separate cases cover polygon order and edge endpoints. Harbor anchors and diagnostic labels also have direct expected values. Expected coordinates are independent from the rendering helper.

A standard initialized frame must render 19 terrain polygons and the expected board labels. Setup fixtures verify road and building attachment to exact canonical IDs.

### Component tests

React component tests cover every visible panel and replay control. Tests use decoded protocol fixtures. Loose mock objects are not accepted.

Controls must preserve the selected frame through ordinary rerenders. Changing speed must not change the frame. Pausing must stop scheduled advancement without changing match data.

### Replay tests

Replay tests cover first, middle, terminal, and truncated matches. Seeking by frame sequence must select the exact frame. Sequential playback and direct seeking must render the same observation at a target frame sequence.

Malformed schemas, unsorted frames, duplicate frame sequences, frame-sequence gaps, decreasing game sequences, and scope inconsistencies must fail before rendering.

### Privacy tests

The protocol projection tests in the engine remain the primary privacy proof. Viewer tests add serialized fixture scans and browser-level checks. Public and player fixtures use distinctive secret values so an accidental leak is easy to detect.

A browser test verifies that route changes and developer-visible page state do not reveal a broader scope.

### Live transport tests

A fake SSE server sends valid and invalid stream cases. These include duplicates, gaps, disconnects, and terminal results. Tests cover atomic decode and deduplication. They also cover resynchronization, retry state, and clean completion.

The viewer must keep the last valid frame visible during a recoverable connection failure.

### Visual and browser tests

Playwright captures reviewed screenshots for:

- An initialized desktop board
- A mid-game desktop board
- A narrow mobile layout
- A negotiation timeline with an active offer
- Diagnostic topology mode

Screenshots use fixed fonts and viewport sizes. They use fixed replay fixtures with animation disabled. Visual changes require review. Browser tests cover keyboard controls and focus order. They also cover reduced motion and the accessible match summary.

## Implementation sequence

### Step 1: viewer protocol

In progress. The engine returns typed public and player observations, and privacy tests inspect serialized public output. Saved replay schemas, frame schemas, Effect decoders, and projection fixtures remain to be added before remote viewing.

### Step 2: application shell

Complete for local setup play. `apps/web` contains a Vite React application with seed and player controls, status, board, player summaries, history controls, and an event list. The production build and component tests pass. Routing, error boundaries, and replay-file loading remain part of the remote viewer work.

### Step 3: board renderer

Complete for the standard board and setup pieces. The layered SVG uses canonical hex, edge, and vertex IDs. It renders terrain, number tokens, robber, harbors, roads, settlements, and engine-supplied legal actions. A manual desktop browser smoke test checked the rendered board.

### Step 4: replay viewer

Complete for trusted local runs. Old reports replay at command boundaries with recorded model time where available. New run directories replay every visible timeline record with exact recorded timing. The board changes only after the full event batch for one game command. The status area shows whether the board was generated or observed. It separately shows the current-generator comparison and native command-verification result. Controls support buttons, keyboard input, a time-based range control, direct URL frame selection, and ten playback speeds. Viewer-safe exported packages remain planned.

### Step 5: live viewing

Complete for trusted local runs. The Vite server reads the selected run directory and sends new records through server-sent events. The browser starts at the latest frame, follows new frames, reconnects automatically, and reloads the run after a sequence gap. It keeps the last valid frame while reconnecting. Component tests cover startup before the first game state and normal completion. A scripted server smoke test covers the HTTP snapshot and SSE endpoints.

### Step 6: negotiation views

Render projected negotiation records in sequence beside binding game events. Message cards show the speaker and public or directed scope. Offer cards show both resource bundles, their current status, and a parent offer when the record is a counteroffer. Promise and evidence cards are marked as nonbinding claims. A completed domestic trade is marked as a binding engine result and links to its game-event sequence.

The component accepts a public or one-seat projection. It does not receive hidden negotiation records and does not implement its own filtering. Tests render the same multi-round transcript through public and seat projections and verify that unauthorized directed text, bundles, and promise evidence are absent from the browser input and output.

Completion requires a multi-round scripted negotiation replay to display only the messages authorized for each scope.

## Project milestone

The local SVG game client, trusted replay viewer, and trusted live viewer are implemented. Public and seat-specific remote viewing still needs server-side projections and privacy tests.

## Merge gate

The viewer milestone is complete only when:

- A saved public replay loads without an engine or server.
- A live scripted match reaches the terminal frame.
- Board elements use the correct canonical topology IDs.
- Replay seeking and sequential playback agree.
- Forced disconnect and frame-sequence gap tests resynchronize.
- Serialized and browser privacy tests find no hidden-data leak.
- Reviewed desktop and mobile screenshots pass.
- Keyboard and reduced-motion checks pass.
- The production web build passes the repository quality gate.

Remote and saved-replay modes remain read-only after this milestone. The trusted local hot-seat client can send native setup commands under the boundary described above.
