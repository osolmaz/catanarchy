# Catanarchy

Catanarchy is a multi-agent Catan simulator and negotiation harness built on Pi. It runs deterministic games in which agents can play and talk. Agents can also make offers or agreements, while the harness records complete training traces.

The repository currently contains the TypeScript simulator foundation. It validates game configuration for three or four players. It also creates a deterministic initial-placement state and records ordered events with a seeded random source.

## Run the simulator

Install Node.js 22 or later, then run:

```sh
npm install
npm run simulate
```

The command prints the initial state for a seeded four-player game.

## Development

Run the full local quality gate:

```sh
npm run check
```

The project uses Effect with strict TypeScript. Oxlint and Oxfmt check the source, while Vitest runs the tests. SimpleDoc and Slophammer check the whole repository. Mutation testing is intentionally disabled. The test strategy combines deterministic unit and property tests with replay tests. It also checks information boundaries and adapter conformance.

Catanarchy contains no game artwork or copied game assets.

## License

[MIT](LICENSE)
