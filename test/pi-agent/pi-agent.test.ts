import { createGame, handleCommand, legalActions, observe } from "@catanarchy/engine";
import type { AgentDecisionRequest, AgentNegotiationRequest, SeatAgent } from "@catanarchy/harness";
import {
  ActionSelectionGate,
  applyEnvironmentAuthentication,
  assertModelsAvailable,
  buildDecisionPrompt,
  buildNegotiationPrompt,
  createPiAgentFactory,
  createPiSeatAgent,
  extractAssistantText,
  ModelRuntime,
  NegotiationSelectionGate,
  negotiationActionFromToolInput,
  parseModelReference,
  resolveSelection,
  selectActionFromText,
  selectNegotiationFromText,
  type PiDecisionChannel,
  type PiModelReference,
} from "@catanarchy/pi-agent";
import type { GameConfig } from "@catanarchy/protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "pi-agent-test",
  seed: 42,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
  ],
};

const request = (): AgentDecisionRequest => {
  const state = Effect.runSync(createGame(config)).state;
  return {
    matchId: state.matchId,
    sequence: state.sequence,
    playerId: "red",
    observation: observe(state, { type: "player", playerId: "red" }),
    legalActions: legalActions(state),
    signal: new AbortController().signal,
  };
};

const negotiationRequest = (): AgentNegotiationRequest => {
  const decision = request();
  return {
    matchId: decision.matchId,
    gameSequence: decision.sequence,
    playerId: decision.playerId,
    turnPlayerId: decision.playerId,
    round: 1,
    observation: decision.observation,
    negotiation: {
      schema: "catanarchy.negotiation-view.v1",
      matchId: decision.matchId,
      sequence: 0,
      events: [],
      offers: [],
      promises: [],
      evidence: [],
    },
    signal: decision.signal,
  };
};

const originalOpenAiKey = process.env["OPENAI_API_KEY"];
const originalHfToken = process.env["HF_TOKEN"];
afterEach(() => {
  if (originalOpenAiKey === undefined) delete process.env["OPENAI_API_KEY"];
  else process.env["OPENAI_API_KEY"] = originalOpenAiKey;
  if (originalHfToken === undefined) delete process.env["HF_TOKEN"];
  else process.env["HF_TOKEN"] = originalHfToken;
});

describe("Pi action selection", () => {
  it("accepts one legal action and terminates the tool turn", () => {
    const gate = new ActionSelectionGate();
    gate.begin(["settlement:v:0:0"]);

    expect(gate.choose("settlement:v:0:0", "Strong numbers.")).toMatchObject({
      details: { accepted: true },
      terminate: true,
    });
    expect(resolveSelection(gate, "", ["settlement:v:0:0"])).toEqual({
      selection: {
        actionId: "settlement:v:0:0",
        reason: "Strong numbers.",
      },
      selectionMode: "tool",
    });
  });

  it("accepts an action without a reason", () => {
    const gate = new ActionSelectionGate();
    gate.begin(["road:e:1"]);

    expect(gate.choose("road:e:1")).toMatchObject({ terminate: true });
    expect(gate.take()).toEqual({ actionId: "road:e:1" });
    expect(gate.take()).toBeUndefined();
  });

  it("poisons a decision after an unknown or duplicate action ID", () => {
    const gate = new ActionSelectionGate();
    gate.begin(["road:e:1"]);

    expect(gate.choose("road:e:2")).toMatchObject({
      isError: true,
      terminate: true,
      details: { accepted: false },
    });
    expect(gate.choose("road:e:1")).toMatchObject({ isError: true, terminate: true });
    expect(resolveSelection(gate, "I choose road:e:1.", ["road:e:1"]).selection).toBeUndefined();

    gate.begin(["road:e:1"]);
    expect(gate.choose("road:e:1")).toMatchObject({ terminate: true });
    expect(gate.choose("road:e:1")).toMatchObject({ isError: true, terminate: true });
    expect(resolveSelection(gate, "I choose road:e:1.", ["road:e:1"]).selection).toBeUndefined();
  });

  it("extracts text from the latest assistant message", () => {
    expect(
      extractAssistantText([
        null,
        {},
        { role: "user", content: [{ type: "text", text: "user" }] },
        { role: "assistant", content: "invalid" },
      ]),
    ).toBe("");
    expect(
      extractAssistantText([
        {
          role: "assistant",
          content: [
            null,
            {},
            { type: "thinking", thinking: "private" },
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toBe("first\nsecond");
  });

  it("accepts one unambiguous action ID from text-only providers", () => {
    expect(selectActionFromText("I choose settlement:v:1:-3.", ["settlement:v:1:-3"])).toEqual({
      actionId: "settlement:v:1:-3",
    });
    const gate = new ActionSelectionGate();
    gate.begin(["settlement:v:1:-3"]);
    expect(resolveSelection(gate, "I choose settlement:v:1:-3.", ["settlement:v:1:-3"])).toEqual({
      selection: { actionId: "settlement:v:1:-3" },
      selectionMode: "text",
    });
    expect(selectActionFromText("No exact ID.", ["settlement:v:1:-3"])).toBeUndefined();
    expect(selectActionFromText("Either road:a or road:b.", ["road:a", "road:b"])).toBeUndefined();
  });

  it("builds a seat-scoped prompt with described legal actions", () => {
    const prompt = buildDecisionPrompt(request());

    expect(prompt).not.toContain("developmentDeck");
    expect(prompt).not.toContain("random");
    expect(prompt).toContain('"ownDevelopmentCards": []');
    expect(prompt).toContain('"ownVictoryPoints": 0');
    expect(prompt).toContain('"longestRoadPlayerId": null');
    expect(prompt).toContain('"playerId": "red"');
    expect(prompt).toContain('"actionId": "settlement:');
    expect(prompt).toContain('"adjacentHexes": [');
  });

  it("describes roll and action-phase choices", () => {
    const normalConfig: GameConfig = { ...config, seed: 0, matchId: "pi-normal-turn" };
    let state = Effect.runSync(createGame(normalConfig)).state;
    while (state.phase.tag !== "turn.roll") {
      state = Effect.runSync(handleCommand(state, legalActions(state)[0]!.command)).state;
    }
    const makeRequest = (): AgentDecisionRequest => ({
      matchId: state.matchId,
      sequence: state.sequence,
      playerId: "red",
      observation: observe(state, { type: "player", playerId: "red" }),
      legalActions: legalActions(state),
      signal: new AbortController().signal,
    });

    expect(buildDecisionPrompt(makeRequest())).toContain('"type": "roll-dice"');
    state = Effect.runSync(handleCommand(state, legalActions(state)[0]!.command)).state;
    expect(buildDecisionPrompt(makeRequest())).toContain('"type": "end-turn"');
  });

  it("describes a legal road after a settlement", () => {
    const created = Effect.runSync(createGame(config));
    const settlement = legalActions(created.state)[0];
    if (settlement === undefined) throw new Error("Expected a settlement action.");
    const state = Effect.runSync(handleCommand(created.state, settlement.command)).state;
    const roadRequest: AgentDecisionRequest = {
      matchId: state.matchId,
      sequence: state.sequence,
      playerId: "red",
      observation: observe(state, { type: "player", playerId: "red" }),
      legalActions: legalActions(state),
      signal: new AbortController().signal,
    };

    expect(buildDecisionPrompt(roadRequest)).toContain('"endpoints"');
  });

  it("adapts a Pi decision channel to the generic seat interface", async () => {
    const current = request();
    const run = vi.fn<PiDecisionChannel["run"]>(async () => ({
      actionId: current.legalActions[0]?.id ?? "missing",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12, cost: 0.001 },
    }));
    const negotiate = vi.fn<PiDecisionChannel["negotiate"]>(async () => ({
      action: { type: "pass" },
      usage: { input: 8, output: 1, cacheRead: 0, cacheWrite: 0, total: 9, cost: 0.0005 },
    }));
    const cancel = vi.fn<PiDecisionChannel["cancel"]>(async () => {});
    const dispose = vi.fn<PiDecisionChannel["dispose"]>(async () => {});
    const model = { provider: "test", modelId: "model" };
    const agent = createPiSeatAgent(model, { run, negotiate, cancel, dispose });

    await expect(agent.decide(current)).resolves.toMatchObject({ usage: { total: 12 } });
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('"playerId": "red"'),
      current.legalActions.map(({ id }) => id),
      current.signal,
    );
    const bargaining = negotiationRequest();
    await expect(agent.negotiate?.(bargaining)).resolves.toMatchObject({
      action: { type: "pass" },
      usage: { total: 9 },
    });
    expect(negotiate).toHaveBeenCalledWith(
      expect.stringContaining('"task": "Choose one negotiation operation'),
      bargaining.signal,
    );
    await agent.cancel();
    await agent.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("Pi negotiation selection", () => {
  it("accepts one structured operation and rejects duplicate selection", () => {
    const gate = new NegotiationSelectionGate();
    gate.begin();

    expect(gate.choose({ type: "pass" }, "No useful trade.")).toMatchObject({
      details: { accepted: true, actionType: "pass" },
      terminate: true,
    });
    expect(gate.choose({ type: "pass" })).toMatchObject({ isError: true, terminate: true });
    expect(gate.take()).toBeUndefined();
  });

  it("builds protocol actions from negotiation tool input", () => {
    expect(
      negotiationActionFromToolInput({
        operation: "make-offer",
        targetPlayerId: "blue",
        scope: "direct",
        scopePlayerId: "blue",
        give: { lumber: 1, brick: 0, wool: 0, grain: 0, ore: 0 },
        receive: { lumber: 0, brick: 1, wool: 0, grain: 0, ore: 0 },
      }),
    ).toEqual({
      type: "make-offer",
      targetPlayerId: "blue",
      scope: { type: "direct", playerId: "blue" },
      give: { lumber: 1, brick: 0, wool: 0, grain: 0, ore: 0 },
      receive: { lumber: 0, brick: 1, wool: 0, grain: 0, ore: 0 },
    });
    expect(
      negotiationActionFromToolInput({ operation: "send-message", scope: "direct", text: "Hi" }),
    ).toBeUndefined();
  });

  it("accepts negotiation JSON from text-only providers", () => {
    expect(
      selectNegotiationFromText('```json\n{"type":"accept-offer","offerId":"offer:1"}\n```'),
    ).toEqual({
      type: "accept-offer",
      offerId: "offer:1",
    });
    expect(selectNegotiationFromText("No operation selected.")).toBeUndefined();
  });

  it("builds a seat-scoped negotiation prompt", () => {
    const prompt = buildNegotiationPrompt(negotiationRequest());

    expect(prompt).toContain('"task": "Choose one negotiation operation');
    expect(prompt).toContain('"ownResources"');
    expect(prompt).toContain('"negotiation"');
    expect(prompt).not.toContain("developmentDeck");
  });
});

describe("Pi model setup", () => {
  it("parses provider and slash-bearing model IDs", () => {
    expect(parseModelReference("huggingface/deepseek-ai/DeepSeek-V4-Flash")).toEqual({
      provider: "huggingface",
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
    });
    expect(() => parseModelReference("missing-provider")).toThrow("Invalid model reference");
  });

  it("requires at least one model", async () => {
    const runtime = await ModelRuntime.create();
    expect(() => createPiAgentFactory({ models: [], modelRuntime: runtime })).toThrow(
      "At least one Pi model",
    );
  });

  it("assigns models to seats in round-robin order and caps output", async () => {
    const runtime = await ModelRuntime.create();
    const references: ReadonlyArray<PiModelReference> = [
      { provider: "openai", modelId: "gpt-5.6-luna" },
      { provider: "huggingface", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
    ];
    const assigned: Array<{ player: string; modelId: string; maxTokens: number }> = [];
    const channel: PiDecisionChannel = {
      async run() {
        return { actionId: "unused" };
      },
      async negotiate() {
        return { action: { type: "pass" } };
      },
      async cancel() {},
      async dispose() {},
    };
    const factory = createPiAgentFactory({
      models: references,
      modelRuntime: runtime,
      maxOutputTokens: 128,
      createChannel: async (player, model) => {
        assigned.push({ player: player.id, modelId: model.id, maxTokens: model.maxTokens });
        return channel;
      },
    });

    const agents: SeatAgent[] = [];
    for (const player of [
      ...config.players,
      { id: "orange", name: "orange", color: "orange" },
    ] as const) {
      agents.push(await factory(player));
    }
    expect(assigned).toEqual([
      { player: "red", modelId: "gpt-5.6-luna", maxTokens: 128 },
      { player: "blue", modelId: "deepseek-ai/DeepSeek-V4-Flash", maxTokens: 128 },
      { player: "white", modelId: "gpt-5.6-luna", maxTokens: 128 },
      { player: "orange", modelId: "deepseek-ai/DeepSeek-V4-Flash", maxTokens: 128 },
    ]);
    expect(agents.map(({ model }) => model)).toEqual([
      references[0],
      references[1],
      references[0],
      references[1],
    ]);
  });

  it("rejects an unknown assigned model and an invalid output cap", async () => {
    const runtime = await ModelRuntime.create();
    const player = config.players[0];
    if (player === undefined) throw new Error("Expected a player.");
    const unknownFactory = createPiAgentFactory({
      models: [{ provider: "test", modelId: "missing" }],
      modelRuntime: runtime,
    });
    await expect(unknownFactory(player)).rejects.toThrow("Unknown Pi model");

    const invalidCapFactory = createPiAgentFactory({
      models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
      modelRuntime: runtime,
      maxOutputTokens: 0,
    });
    await expect(invalidCapFactory(player)).rejects.toThrow("maxOutputTokens");
  });

  it("loads supported credentials from process environment without persistence", async () => {
    process.env["OPENAI_API_KEY"] = "test-openai";
    process.env["HF_TOKEN"] = "test-hf";
    const setRuntimeApiKey = vi.fn<ModelRuntime["setRuntimeApiKey"]>(async () => {});
    const runtime = { setRuntimeApiKey } as unknown as ModelRuntime;

    await applyEnvironmentAuthentication(runtime, [
      { provider: "openai", modelId: "gpt-5.6-luna" },
      { provider: "huggingface", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
      { provider: "openai", modelId: "gpt-5.6-sol" },
    ]);

    expect(setRuntimeApiKey).toHaveBeenCalledTimes(2);
    expect(setRuntimeApiKey).toHaveBeenCalledWith("openai", "test-openai");
    expect(setRuntimeApiKey).toHaveBeenCalledWith("huggingface", "test-hf");

    delete process.env["OPENAI_API_KEY"];
    delete process.env["HF_TOKEN"];
    setRuntimeApiKey.mockClear();
    await applyEnvironmentAuthentication(runtime, [
      { provider: "openai", modelId: "gpt-5.6-luna" },
      { provider: "other", modelId: "model" },
    ]);
    expect(setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("accepts known authenticated models", async () => {
    const model = { id: "known" };
    const runtime = {
      getModel: vi.fn<() => { readonly id: string }>(() => model),
      getAuth: vi.fn<() => Promise<{ readonly apiKey: string }>>(async () => ({
        apiKey: "hidden",
      })),
    } as unknown as ModelRuntime;

    await expect(
      assertModelsAvailable(runtime, [{ provider: "test", modelId: "known" }]),
    ).resolves.toBeUndefined();
  });

  it("rejects missing models and authentication", async () => {
    const getModel = vi.fn<
      (_provider: string, modelId: string) => { readonly id: string } | undefined
    >((_provider, modelId) => (modelId === "known" ? { id: modelId } : undefined));
    const getAuth = vi.fn<() => Promise<undefined>>(async () => undefined);
    const runtime = { getModel, getAuth } as unknown as ModelRuntime;

    await expect(
      assertModelsAvailable(runtime, [{ provider: "test", modelId: "missing" }]),
    ).rejects.toThrow("Unknown Pi model");
    await expect(
      assertModelsAvailable(runtime, [{ provider: "test", modelId: "known" }]),
    ).rejects.toThrow("Authentication is not configured");
  });
});
