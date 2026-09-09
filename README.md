# Catanarchy

Catanarchy is a deterministic Catan simulator for agent research. The long-term goal is to let agents play, talk, negotiate, and make structured trades through one protocol. Native games and external adapters will use the same commands and observations.

The current simulator supports the regular three-player and four-player board and the full initial-placement round. The local web app lets you start a seeded game, place settlements and roads, inspect player summaries, and move through the accepted-command history. Normal turns, negotiation, adapters, and Pi agents come later.

## Start the web app

Install Node.js 22 or later. Then run:

```sh
npm install
npm run dev
```

Open the local URL that Vite prints. Choose a seed and player count, select **New game**, then use the highlighted board points and edges to place each player's pieces.

The web app is a trusted local hot-seat client. It keeps the authoritative game state in the browser so it can show the active player's initial resource cards. A future remote viewer will receive only public or seat-authorized observations.

## Run a scripted setup

```sh
npm run simulate -- --seed=42
```

The command starts a four-player game and selects the first legal action until initial placement is complete. It prints the final phase, piece counts, and event count.

## Design

- [Implementation plan](docs/PLAN.md)
- [Engine design and correctness plan](docs/ENGINE.md)
- [Web viewer design](docs/VIEWER.md)
- [Colonist compatibility profile](docs/COLONIST.md)

## Development

Run the full local quality gate:

```sh
npm run check
```

The project uses Effect with strict TypeScript. Oxlint and Oxfmt check the source. Vitest runs unit, property, replay, privacy, and component tests. SimpleDoc and Slophammer check the repository. Mutation testing is intentionally disabled.

The code is split into protocol, engine, CLI, and web modules. The engine stays deterministic and does not depend on Pi, browsers, networks, or databases. Catanarchy contains no game artwork or copied game assets.

## License

[MIT](LICENSE)
