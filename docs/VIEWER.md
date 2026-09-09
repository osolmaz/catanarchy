# Web viewer design

## Status

The web viewer is planned but not implemented. This document makes it a formal project milestone.

The first viewer is read-only. It displays live matches and saved replays without becoming another game engine. Human command input can be added later through a separate client contract.

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

The first release supports the regular three-player and four-player base-game board defined in the [engine design](ENGINE.md). It renders original geometric shapes and text. It does not use copied board artwork or game assets.

The first release excludes command entry, matchmaking, accounts, ratings, map editing, and expansion layouts. It also excludes public access to referee state.

## Boundary

The viewer consumes viewer-safe protocol data. It does not import authoritative engine state or run game rules.

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

The engine decides what is public or private before serialization. The browser cannot request hidden cards merely by changing a React property or URL query.

The viewer does not calculate legal actions, resource production, awards, or victory. It displays those values from observations and projected events. This rule prevents the UI from becoming a second implementation of the game.

## Repository layout

The web application will use this layout when implementation starts:

```text
apps/
  web/
    src/
      board/
      components/
      replay/
      transport/
      views/
    test/
packages/
  protocol/
  engine/
```

The viewer is the first independent application build. Its implementation therefore triggers the workspace split already allowed by the [implementation plan](PLAN.md). Empty packages do not need to be created before that work starts.

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

The viewer uses the engine's integer vertex lattice. For vertex `(x, y)` and visual hex radius `scale`, the SVG coordinates are:

```text
screenX = originX + scale * x / 2
screenY = originY + scale * sqrt(3) * y / 2
```

Positive engine `y` points down, which matches SVG. The viewer calculates a padded `viewBox` from the transformed topology bounds. Window size changes the rendered SVG size, not the underlying coordinates.

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

The desktop viewer contains:

- Match header with status, turn, phase, frame sequence, and game sequence
- SVG board
- Public player summary
- Dice and bank summary
- Chat and trade timeline
- Replay controls
- Event inspector
- Connection and projection status

A narrow screen stacks these regions. The board stays first. The current match summary and replay controls follow it. Long timelines and event data use virtualized lists only after measured size requires them.

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

The viewer supports keyboard control for replay navigation. Buttons have visible focus states and text labels. Playback does not start automatically.

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

Add the Effect schemas for the viewer protocol. Add public and player projection fixtures. Keep referee fixtures private to tests.

Completion requires protocol and privacy tests to pass.

### Step 2: application shell

Create the npm workspace and `apps/web` Vite application. Add routing, error boundaries, loading states, and the static page layout. Load a checked replay fixture without a server.

Completion requires production build and component tests to pass.

### Step 3: board renderer

Implement the SVG transform and ordered layers. Add diagnostic IDs and overlays. Review fixed screenshots against the engine topology fixture.

Completion requires the standard topology and setup positions to render at the correct canonical locations.

### Step 4: replay viewer

Add replay-file loading, controls, frame navigation, timeline display, and event inspection. Keep frame selection independent from the engine.

Completion requires sequential playback and direct seeking to agree at every fixture frame.

### Step 5: live viewing

Add latest-frame HTTP loading and the SSE client. Check both sequence fields. Add reconnection and resynchronization through a fake server before connecting the harness.

Completion requires a live scripted match to remain correct across a forced disconnect and frame-sequence gap.

### Step 6: negotiation views

Add chat visibility, offer state, counteroffers, and transfer outcomes when the negotiation protocol is implemented. Preserve the distinction between speech and binding operations.

Completion requires a multi-round scripted negotiation replay to display only the messages authorized for each scope.

## Project milestone

The diagnostic SVG renderer can begin during engine Milestone 1. The complete read-only replay and live viewer becomes its own milestone after the base game engine is complete and before Pi agents are added. Negotiation work then extends the existing timeline rather than creating another UI.

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

The viewer remains read-only after this milestone. A human-play client needs its own command and authorization plan.
