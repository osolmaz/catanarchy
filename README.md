# Catanarchy

Catanarchy is a deterministic Catan simulator for agent research. The long-term goal is to let agents play, talk, negotiate, and make structured trades through one protocol. Native games and external adapters will use the same commands and observations.

The current simulator supports the regular three-player and four-player board, initial placement, production, building, maritime and domestic trade, robber theft, development cards, Longest Road, Largest Army, scoring, and game completion. The harness runs bounded public or directed negotiation rounds with offers, counteroffers, messages, promises, and atomic trade settlement. The local web app can submit game actions, inspect accepted-command history, watch a running agent match, and replay it at different speeds. A Pi agent harness can run complete scripted or model-driven games with separate sessions and structured game-action and negotiation tools. External adapters come later.

## Start the web app

Install Node.js 22.19 or later. Then run:

```sh
npm install
npm run dev
```

Open the local URL that Vite prints. Choose a seed and player count, select **New game**, then use the highlighted board points, edges, and action buttons to play.

To inspect an old saved Pi report, start the temporary viewer with the report path:

```sh
CATANARCHY_RUN_FILE=/path/to/run.json npm run dev
```

New Pi matches write a run directory. Open it in the viewer from another terminal while the match is running:

```sh
CATANARCHY_RUN_DIR=/path/printed/by/play-pi npm run dev
```

The viewer follows new records as they arrive. You can pause, move through the timeline, return to the latest record, or select a replay speed from 1× through 1000×. Each Pi seat has a link to its native Pi session JSONL file after that seat makes its first model request.

The web app and run viewer are trusted local views. They can use authoritative state, private traces, and private Pi sessions. A future remote viewer will receive only public or seat-authorized observations.

## Run a scripted setup

```sh
npm run simulate -- --seed=42
```

The command starts a four-player game and selects the first legal action until initial placement is complete. It prints the final phase, piece counts, and event count.

## Run a Pi agent match

Set the provider credentials in the process environment, then supply one or more Pi model references:

```sh
OPENAI_API_KEY=... HF_TOKEN=... npm run play:pi -- \
  --models=openai/gpt-5.6-luna,huggingface/deepseek-ai/DeepSeek-V4-Flash \
  --seed=42
```

Four seats receive the models in round-robin order. The command runs 16 setup decisions by default. Add `--decisions=17` to include the first dice roll or use a larger bound to continue through normal turns, negotiation, robber resolution, and development-card effects. Negotiation uses one round per turn by default. Set `--negotiation-rounds=0` to disable it or select a larger bounded value. Use `--thinking=off` through `--thinking=xhigh` to select the Pi thinking level. The command limits requests, output tokens, and each seat's context window. It enables Pi compaction for long games and includes one possible compaction call per request in its conservative cost estimate. The default cost ceiling is $5. Use `--cost-ceiling-usd` only with approval for that cumulative limit.

Each run is saved under `runs/` by default. The command prints the exact path before the first model request. Use `--run-dir=/path/to/run` to choose another path. Add `--output=path.json` only when you also need the older single-file result format.

Continue a stopped run with `npm run play:pi -- resume --run-dir=<path> --mode=warm|cold --decisions=<total decisions for the whole run>`. A warm resume keeps each seat's Pi session. A cold resume starts fresh seat sessions on the same board and hands. Resume continues from the last completed command, so a run that stopped inside a negotiation round cannot resume. See [Resume](docs/RESUME.md).

Use `npm run probe:pi -- --model=provider/model-id` for one live model decision. Live model commands are opt-in and are not part of the normal quality gate.

## Design

- [Implementation plan](docs/PLAN.md)
- [Agent harness](docs/AGENT_HARNESS.md)
- [Engine design and correctness plan](docs/ENGINE.md)
- [Web viewer design](docs/VIEWER.md)
- [Run log format](docs/RUN_LOG.md)
- [Resume](docs/RESUME.md)
- [DeepSeek V4.1 Flash seed 47 run report](docs/2026-09-11-deepseek-v4-1-flash-seed-47.md)
- [Colonist compatibility profile](docs/COLONIST.md)

## Development

Run the full local quality gate:

```sh
npm run check
```

The project uses Effect with strict TypeScript. Oxlint and Oxfmt check the source. Vitest runs unit, property, replay, privacy, and component tests. SimpleDoc and Slophammer check the repository. Mutation testing is intentionally disabled.

The code is split into protocol, engine, harness, Pi agent, CLI, and web modules. The engine stays deterministic and does not depend on Pi, browsers, networks, or databases. Colonist board art is isolated in the web viewer and never forms part of an agent observation.

## License

The Catanarchy code is [MIT](LICENSE). The imported Colonist viewer art is listed separately in [Third-party assets](THIRD_PARTY_ASSETS.md).
