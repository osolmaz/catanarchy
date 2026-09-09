# AGENTS.md

- Use Node.js 22 or later.
- Use TypeScript with strict compiler settings. Do not weaken a compiler option to make code pass.
- Keep `packages/engine` deterministic, headless, and independent from Pi, network clients, databases, and user interfaces.
- Keep player-visible observations separate from the authoritative state. Tests must prove that private cards and hidden development cards do not leak.
- Use Effect for typed failures, dynamic-boundary decoding, resource management, concurrency, and service composition. Keep simple game calculations as plain pure functions.
- Use an explicit seeded random source. Do not call `Math.random()` in production code.
- Represent changes as commands and ordered events. A replay from the same configuration and commands must produce the same events and state.
- Follow `docs/ENGINE.md` as the Milestone 1 implementation contract. Update it before changing a locked decision.
- Keep remote and replay viewers read-only. The trusted local hot-seat client can send setup commands to the native engine. Follow `docs/VIEWER.md` for viewer data, privacy, rendering, and tests.
- Keep free-form messages separate from binding game operations. The engine validates and commits structured trades. The harness records arguments, promises, and other speech.
- Keep Pi integration under its own boundary. Use documented Pi SDK APIs unless a separately approved plan requires a core change.
- Follow the dependency boundaries in `slophammer.yml`.
- Do not add game artwork, copied rulebook text, or other game assets.
- Do not add mutation testing. Use unit, property, replay, information-boundary, and conformance tests.
- Use Conventional Commits for commit messages and pull request titles.
- Run `npm run check` before finishing a change.
