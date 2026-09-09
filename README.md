# Catanarchy

Catanarchy is a deterministic Catan simulator for agent research. The long-term goal is to let agents play, talk, negotiate, and make structured trades through one protocol. Native games and external adapters will use the same commands and observations.

The current simulator supports the regular three-player and four-player board and the full initial-placement round. The local web app lets you start a seeded game, place settlements and roads, inspect player summaries, and move through the accepted-command history. A Pi agent harness can run scripted or model-driven initial placement with isolated sessions and game-only tools. Normal turns, negotiation, and adapters come later.

## Start the web app

Install Node.js 22.12 or later. Then run:

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

## Run a Pi setup match

Set the provider credentials in the process environment, then supply one or more Pi model references:

```sh
OPENAI_API_KEY=... HF_TOKEN=... npm run play:pi -- \
  --models=openai/gpt-5.6-luna,huggingface/deepseek-ai/DeepSeek-V4-Flash \
  --seed=42
```

Four seats receive the models in round-robin order. The command runs only initial placement because normal turns are not implemented. It limits requests and output tokens, prints a cost estimate before the first request, and uses the first legal action if a model fails. Add `--output=path.json` to save the full result outside the repository.

Use `npm run probe:pi -- --model=provider/model-id` for one live model decision. Live model commands are opt-in and are not part of the normal quality gate.

## Design

- [Implementation plan](docs/PLAN.md)
- [Agent harness](docs/AGENT_HARNESS.md)
- [Engine design and correctness plan](docs/ENGINE.md)
- [Web viewer design](docs/VIEWER.md)
- [Colonist compatibility profile](docs/COLONIST.md)

## Development

Run the full local quality gate:

```sh
npm run check
```

The project uses Effect with strict TypeScript. Oxlint and Oxfmt check the source. Vitest runs unit, property, replay, privacy, and component tests. SimpleDoc and Slophammer check the repository. Mutation testing is intentionally disabled.

The code is split into protocol, engine, harness, Pi agent, CLI, and web modules. The engine stays deterministic and does not depend on Pi, browsers, networks, or databases. Catanarchy contains no game artwork or copied game assets.

## License

[MIT](LICENSE)
