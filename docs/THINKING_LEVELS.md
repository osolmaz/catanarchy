# Thinking levels

## Purpose

The runner passes one `--thinking` level to every seat of a game. A model maps that level to a provider value, and the provider may accept a different set of values than the harness. This document records the level names, the mapping rule, the values the Novita route accepts for DeepSeek V4.1 Flash, and what the levels measured like in a repeated test. Read it with a launch record to know which effort a seat really sent.

## Level names

`PI_THINKING_LEVELS` at `packages/pi-agent/src/index.ts:43` holds the seven names, in this order: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. That list is the single source for the `--thinking` argument and for the `PiThinkingLevel` type, so the CLI rejects any other value before a launch.

Pi's own list, `EXTENDED_THINKING_LEVELS` in `@earendil-works/pi-ai` at `dist/models.js:550`, holds the same seven names. `getSupportedThinkingLevels` then filters the list per model:

- a model without reasoning support allows `off` only;
- a level mapped to `null` is not allowed for that model;
- `xhigh` and `max` are allowed only when the model names them in its map.

`clampThinkingLevel` moves a disallowed request to the nearest allowed level. A level that the model does not name therefore changes the request instead of failing it.

## How a level reaches the provider

The model entry carries `thinkingLevelMap`. The adapters send the mapped value, `thinkingLevelMap[level] ?? level`:

- the OpenAI Responses adapter sends it as `reasoning.effort`;
- the openai-completions adapter sends it as `reasoning_effort`.

The Hugging Face provider takes the generic openai-completions branch, because `isDeepSeek` in `detectCompat` matches only a `deepseek` provider or a `deepseek.com` base URL. The Novita route arrives as provider `huggingface` with base URL `https://router.huggingface.co/v1`, so the detected compatibility is `thinkingFormat: "openai"` with `supportsReasoningEffort: true`, and the mapped value goes out unchanged.

## Level maps in the run store

The run store is `/home/onur/.cache/catanarchy/models-store.json`.

| Level     | luna, terra, sol | DeepSeek V4.1 Flash (Novita) |
| --------- | ---------------- | ---------------------------- |
| `off`     | `none`           | `none`                       |
| `minimal` | not allowed      | not allowed                  |
| `low`     | `low`            | `low`                        |
| `medium`  | `medium`         | not allowed                  |
| `high`    | `high`           | `high`                       |
| `xhigh`   | `xhigh`          | `xhigh`                      |
| `max`     | `max`            | `high` (run-store pin)       |

The entry for DeepSeek holds `"max": "high"` by hand. That pin is the reason a `--thinking=max` run raises terra and sol only. To raise DeepSeek instead, change that one value in the store and leave every other entry alone.

## Values the Novita route accepts

A direct probe on 2026-09-14 sent one short request per candidate value to `https://router.huggingface.co/v1/chat/completions` with the model `deepseek-ai/DeepSeek-V4.1-Flash:novita`.

| Sent value                                                 | Answer                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | accepted                                                                                                           |
| `off`, `extreme`, `ultra`, `highest`, `bogus`              | HTTP 400 invalid request                                                                                           |
| `0`, `1`, `50`, `100`, `101` as JSON numbers               | HTTP 400 `cannot unmarshal number into Go struct field ChatCompletionRequestAlias.reasoning_effort of type string` |
| `"0"`, `"1"`, `"100"`, `"101"` as JSON strings             | HTTP 400 invalid request                                                                                           |

The accepted set is the same seven names as the harness vocabulary, and `max` is the top. The parameter must be a string.

`none` is accepted and returns no reasoning tokens at all, so it turns thinking off.

The model card for DeepSeek V4.1 Flash describes a continuously controllable reasoning effort as an integer from 1 to 100, and its own instruct benchmarks use `reasoning_effort=100`. That numeric scale is not reachable on this route: every numeric value is refused, as a number and as a string.

## Measured reasoning length

A second test on 2026-09-14 sent one hard prompt five times per level, with `max_tokens=40000`, `temperature=1.0`, and `top_p=0.95`. All 30 calls finished with `stop`, so no sample was truncated.

| Level     | Minimum | Median | Maximum |  Mean |
| --------- | ------: | -----: | ------: | ----: |
| `low`     |   2,893 |  3,639 |   4,282 | 3,568 |
| `minimal` |   3,395 |  4,778 |   5,407 | 4,628 |
| `medium`  |   2,632 |  5,300 |   9,232 | 6,238 |
| `xhigh`   |   2,582 |  6,391 |  10,585 | 6,016 |
| `high`    |   3,606 |  6,409 |  19,816 | 8,935 |
| `max`     |   5,971 |  8,012 |  10,487 | 8,067 |

The medians rise from `low` to `max`, and `max` never fell below 5,971 while `low` never passed 4,282. Three details limit the reading:

- the spread inside one level is two to four times its median, and it is larger than the gap between neighbouring levels;
- `high` produced the largest single sample, 19,816 reasoning tokens and 78 seconds;
- the mean order differs from the median order, because `medium` and `high` both hold one long sample.

Measured on one prompt, the level is a weak lever. A level change of one step moves the median by far less than the model's own run-to-run spread.

A single sample is not enough to read this ladder. An earlier one-sample probe on the same prompt gave `medium` 17,198 reasoning tokens and `max` 5,211, which is the reverse of the medians. The campaign report keeps that one-sample table for the record, and its `max` row of 28,110 tokens is an outlier of the same kind.

## What the finished games sent

Every finished game sent `reasoning_effort: high` to the DeepSeek seats, in all four level and window cells:

| Cell                     | Flag               | DeepSeek value |
| ------------------------ | ------------------ | -------------- |
| luna mixed pair          | `--thinking=high`  | `high`         |
| luna xhigh pair          | `--thinking=xhigh` | `high`         |
| terra and sol high cells | `--thinking=high`  | `high`         |
| terra and sol max cells  | `--thinking=max`   | `high`         |

The xhigh pair used a store copy that maps DeepSeek `xhigh` to `high`. The max cells used the pin described above.

A session file records the harness level in its `thinking_level_change` entry, not the value that went to the provider. A DeepSeek session from a max cell therefore says `thinkingLevel: "max"` while the request carried `high`. The `levels` block in each published `analysis.json` states the wire value.

## Repeating the probe

The three probe tools live in `/home/onur/scratch/catanarchy-tools/`: `novita-effort-probe.py` (accept and reject, including numbers), `novita-effort-map.py` (the accepted set, then one hard prompt per accepted value), and `novita-effort-repeat.py` (five samples per level). Each reads `HF_TOKEN` from the environment through `launch-with-secrets.mjs` and never prints it.

Their raw output is in `/home/onur/scratch/catanarchy-novita-effort-probe.json`, `/home/onur/scratch/catanarchy-novita-effort-map.json`, and `/home/onur/scratch/catanarchy-novita-effort-repeat.json`. The three probes together cost about $0.30.

## Related documents

- [Agent harness](AGENT_HARNESS.md) lists the runner flags.
- [Mixed-seat seed 47 paired run report](2026-09-12-mixed-seat-seed-47-pair.md) holds the first, single-sample level probe.
- [Level and time-window seed 47 run report](2026-09-13-level-and-window-seed-47.md) holds the level and window cells.
