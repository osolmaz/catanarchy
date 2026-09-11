import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createGame, handleCommand, legalActions, observe } from "@catanarchy/engine";
import {
  AgentDecisionError,
  AgentRunAbort,
  type AgentDecisionRequest,
  type AgentNegotiationRequest,
  type SeatAgent,
} from "@catanarchy/harness";
import {
  ActionSelectionGate,
  applyEnvironmentAuthentication,
  assertModelsAvailable,
  buildDecisionPrompt,
  buildNegotiationPrompt,
  compactionSettingsForContext,
  createPiAgentFactory,
  createPiSeatAgent,
  extractAssistantText,
  InspectionGate,
  ModelRuntime,
  NegotiationSelectionGate,
  negotiationActionFromToolInput,
  parseModelReference,
  PiCostBudget,
  pinOpenRouterProvider,
  resolveSelection,
  selectActionFromText,
  selectNegotiationFromText,
  TurnBudget,
  withPiCostBudget,
  type PiDecisionChannel,
  type PiModelReference,
  type PiSessionReference,
} from "@catanarchy/pi-agent";
import type { GameConfig, PlayerConfig } from "@catanarchy/protocol";
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
    turnKey: "setup:forward:0",
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
    turnKey: decision.turnKey,
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
const temporaryDirectories: string[] = [];
afterEach(async () => {
  if (originalOpenAiKey === undefined) delete process.env["OPENAI_API_KEY"];
  else process.env["OPENAI_API_KEY"] = originalOpenAiKey;
  if (originalHfToken === undefined) delete process.env["HF_TOKEN"];
  else process.env["HF_TOKEN"] = originalHfToken;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Pi action selection", () => {
  it("accepts one legal action and terminates the tool turn", () => {
    const gate = new ActionSelectionGate();
    gate.begin(["settlement:v:0:0"]);
    expect(gate.isComplete()).toBe(false);

    expect(gate.choose("settlement:v:0:0", "Strong numbers.")).toMatchObject({
      details: { accepted: true },
      terminate: true,
    });
    expect(gate.isComplete()).toBe(true);
    expect(resolveSelection(gate, "", ["settlement:v:0:0"])).toEqual({
      selection: {
        actionId: "settlement:v:0:0",
        reason: "Strong numbers.",
      },
      selectionMode: "tool",
    });
    expect(gate.isComplete()).toBe(false);
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
    expect(gate.isComplete()).toBe(true);
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

  it("allows several nonterminating inspections in one turn", () => {
    const budget = new TurnBudget(90_000, 30_000, 2);
    const gate = new InspectionGate();
    budget.begin("turn:1");
    gate.begin({ status: { phase: "turn.action" }, inventory: { lumber: 1 } }, budget);

    const firstInspection = gate.inspect("status");
    expect(firstInspection).toMatchObject({
      details: { section: "status", accepted: true },
    });
    expect(firstInspection).not.toHaveProperty("terminate");
    const secondInspection = gate.inspect("inventory");
    expect(secondInspection).toMatchObject({
      details: { section: "inventory", accepted: true },
    });
    expect(secondInspection).not.toHaveProperty("terminate");
    expect(gate.inspect("status")).toMatchObject({ isError: true, terminate: true });
    expect(gate.isComplete()).toBe(true);

    budget.begin("turn:2");
    gate.begin({ status: { phase: "turn.roll" } }, budget);
    expect(gate.isComplete()).toBe(false);
    expect(gate.inspect("negotiation")).toMatchObject({ isError: true });
    expect(gate.inspect("status")).toMatchObject({ details: { accepted: true } });
    gate.disable();
    expect(gate.inspect("status")).toMatchObject({ isError: true });
  });

  it("shares active time across requests in one turn and resets for the next turn", () => {
    const budget = new TurnBudget(90_000, 30_000, 2);
    budget.begin("turn:1");
    expect(budget.warningDelays()).toEqual([
      { thresholdMs: 45_000, delayMs: 45_000 },
      { thresholdMs: 80_000, delayMs: 80_000 },
    ]);
    budget.markWarning(45_000);
    expect(budget.warningDelays()).toEqual([{ thresholdMs: 80_000, delayMs: 80_000 }]);
    budget.consume("exploration", 25_000);
    budget.consume("finalization", 5_000);

    budget.begin("turn:1");
    expect(budget.remaining("exploration")).toBe(65_000);
    expect(budget.remaining("finalization")).toBe(25_000);
    expect(budget.warningDelays()).toEqual([{ thresholdMs: 80_000, delayMs: 55_000 }]);
    expect(budget.takePlanningStep()).toBe(true);
    expect(budget.takePlanningStep()).toBe(true);
    expect(budget.takePlanningStep()).toBe(false);

    budget.begin("turn:2");
    expect(budget.remaining("exploration")).toBe(90_000);
    expect(budget.remaining("finalization")).toBe(30_000);
    expect(budget.takePlanningStep()).toBe(true);
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

    const timedOutGate = new ActionSelectionGate();
    timedOutGate.begin(["road:a"]);
    expect(resolveSelection(timedOutGate, "I considered road:a.", ["road:a"], false)).toEqual({
      selection: undefined,
      selectionMode: "text",
    });
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
      turnKey: "turn:1",
      observation: observe(state, { type: "player", playerId: "red" }),
      legalActions: legalActions(state),
      signal: new AbortController().signal,
    });

    expect(buildDecisionPrompt(makeRequest())).toContain('"type": "roll-dice"');
    state = Effect.runSync(handleCommand(state, legalActions(state)[0]!.command)).state;
    expect(buildDecisionPrompt(makeRequest())).toContain('"type": "end-turn"');
  });

  it("describes unknown graph IDs without exposing engine state", () => {
    const current = request();
    const action = current.legalActions[0];
    if (action === undefined || action.command.command.type !== "place-initial-settlement") {
      throw new Error("Expected an initial settlement action.");
    }
    const malformedAction = {
      ...action,
      command: {
        ...action.command,
        command: { ...action.command.command, vertexId: "v:999:999" as const },
      },
    };
    const prompt = buildDecisionPrompt({ ...current, legalActions: [malformedAction] });

    expect(prompt).toContain('"vertexId": "v:999:999"');
    expect(prompt).toContain('"adjacentHexes": []');
    expect(prompt).toContain('"harbors": []');
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
      turnKey: "setup:forward:0",
      observation: observe(state, { type: "player", playerId: "red" }),
      legalActions: legalActions(state),
      signal: new AbortController().signal,
    };

    expect(buildDecisionPrompt(roadRequest)).toContain('"endpoints"');
    const road = roadRequest.legalActions[0];
    if (road === undefined || road.command.command.type !== "place-initial-road") {
      throw new Error("Expected an initial road action.");
    }
    const malformedRoad = {
      ...road,
      command: {
        ...road.command,
        command: { ...road.command.command, edgeId: "e:v:999:999|v:998:998" as const },
      },
    };
    expect(buildDecisionPrompt({ ...roadRequest, legalActions: [malformedRoad] })).toContain(
      '"endpoints": []',
    );
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
    expect(run).toHaveBeenCalledWith(current);
    const bargaining = negotiationRequest();
    await expect(agent.negotiate?.(bargaining)).resolves.toMatchObject({
      action: { type: "pass" },
      usage: { total: 9 },
    });
    expect(negotiate).toHaveBeenCalledWith(bargaining);
    await agent.cancel();
    await agent.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("Pi negotiation selection", () => {
  it("accepts one structured operation and rejects duplicate selection", () => {
    const gate = new NegotiationSelectionGate();
    expect(gate.isComplete()).toBe(false);
    expect(gate.choose({ type: "pass" })).toMatchObject({ isError: true, terminate: true });
    expect(gate.isComplete()).toBe(true);
    gate.begin();

    expect(gate.choose({ type: "pass" }, "No useful trade.")).toMatchObject({
      details: { accepted: true, actionType: "pass" },
      terminate: true,
    });
    expect(gate.isComplete()).toBe(true);
    expect(gate.choose({ type: "pass" })).toMatchObject({ isError: true, terminate: true });
    expect(gate.take()).toBeUndefined();

    gate.begin();
    expect(gate.choose(undefined)).toMatchObject({ isError: true, terminate: true });

    const noReasonGate = new NegotiationSelectionGate();
    noReasonGate.begin();
    expect(noReasonGate.choose({ type: "pass" })).toMatchObject({ details: { accepted: true } });
    expect(noReasonGate.take()).toEqual({ action: { type: "pass" } });
  });

  it("builds protocol actions from negotiation tool input", () => {
    expect(negotiationActionFromToolInput({ operation: "pass" })).toEqual({ type: "pass" });
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
    expect(
      negotiationActionFromToolInput({
        operation: "send-message",
        scope: "public",
        text: "Ore is scarce.",
      }),
    ).toEqual({ type: "send-message", scope: { type: "public" }, text: "Ore is scarce." });
    expect(
      negotiationActionFromToolInput({
        operation: "counter-offer",
        offerId: "offer:1",
        scope: "direct",
        scopePlayerId: "red",
        give: { lumber: 0, brick: 1, wool: 0, grain: 0, ore: 0 },
        receive: { lumber: 1, brick: 0, wool: 0, grain: 0, ore: 0 },
      }),
    ).toMatchObject({ type: "counter-offer", offerId: "offer:1" });
    expect(
      negotiationActionFromToolInput({ operation: "accept-offer", offerId: "offer:1" }),
    ).toEqual({ type: "accept-offer", offerId: "offer:1" });
    expect(
      negotiationActionFromToolInput({ operation: "reject-offer", offerId: "offer:1" }),
    ).toEqual({ type: "reject-offer", offerId: "offer:1" });
    expect(
      negotiationActionFromToolInput({ operation: "withdraw-offer", offerId: "offer:1" }),
    ).toEqual({ type: "withdraw-offer", offerId: "offer:1" });
    expect(
      negotiationActionFromToolInput({
        operation: "record-promise",
        beneficiaryPlayerId: "blue",
        scope: "public",
        text: "I will return one grain.",
        relatedOfferId: "offer:1",
      }),
    ).toEqual({
      type: "record-promise",
      beneficiaryPlayerId: "blue",
      scope: { type: "public" },
      text: "I will return one grain.",
      relatedOfferId: "offer:1",
    });
    expect(
      negotiationActionFromToolInput({
        operation: "record-promise",
        beneficiaryPlayerId: "blue",
        scope: "public",
        text: "No linked offer.",
      }),
    ).toMatchObject({ type: "record-promise", relatedOfferId: null });
    expect(
      negotiationActionFromToolInput({
        operation: "record-promise-evidence",
        promiseId: "promise:1",
        gameSequence: 8,
        text: "The road was built.",
      }),
    ).toEqual({
      type: "record-promise-evidence",
      promiseId: "promise:1",
      gameSequence: 8,
      text: "The road was built.",
    });
  });

  it("accepts negotiation JSON from text-only providers", () => {
    expect(
      selectNegotiationFromText('```json\n{"type":"accept-offer","offerId":"offer:1"}\n```'),
    ).toEqual({
      type: "accept-offer",
      offerId: "offer:1",
    });
    expect(selectNegotiationFromText('{"action":{"type":"pass"}}')).toEqual({ type: "pass" });
    expect(selectNegotiationFromText("No operation selected.")).toBeUndefined();
  });

  it("builds a seat-scoped negotiation prompt", () => {
    const prompt = buildNegotiationPrompt(negotiationRequest());

    expect(prompt).toContain('"task": "Choose one negotiation operation');
    expect(prompt).toContain('"ownResources"');
    expect(prompt).toContain('"negotiation"');
    expect(prompt).not.toContain("developmentDeck");
  });

  it("bounds negotiation history in the model prompt", () => {
    const base = negotiationRequest();
    const promises = Array.from({ length: 34 }, (_value, index) => ({
      id: `promise:${index}`,
      round: 1,
      playerId: "red",
      beneficiaryPlayerId: "blue",
      scope: { type: "public" as const },
      text: `Promise ${index}`,
      relatedOfferId: null,
    }));
    const prompt = buildNegotiationPrompt({
      ...base,
      negotiation: {
        ...base.negotiation,
        events: Array.from({ length: 130 }, (_value, sequence) => ({
          schema: "catanarchy.negotiation-event.v1" as const,
          matchId: base.matchId,
          sequence,
          gameSequence: base.gameSequence,
          event: {
            type: "negotiation.message-sent" as const,
            round: 1,
            playerId: "red",
            scope: { type: "public" as const },
            text: "x".repeat(10_000),
          },
        })),
        promises,
        evidence: promises.flatMap((promise, index) =>
          Array.from({ length: 3 }, (_value, evidenceIndex) => ({
            id: `evidence:${index}:${evidenceIndex}`,
            round: 1,
            playerId: "blue",
            promiseId: promise.id,
            gameSequence: base.gameSequence,
            text: "Evidence",
          })),
        ),
      },
    });
    const projected = JSON.parse(prompt) as {
      negotiation: {
        sequence: number;
        events: Array<{ sequence: number }>;
        promises: Array<{ id: string }>;
        evidence: unknown[];
      };
    };

    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(24_576);
    expect(projected.negotiation.events.length).toBeLessThanOrEqual(128);
    expect(projected.negotiation.sequence).toBe(projected.negotiation.events.length);
    expect(projected.negotiation.events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: projected.negotiation.events.length }, (_value, sequence) => sequence),
    );
    expect(projected.negotiation.promises.length).toBeLessThanOrEqual(32);
    expect(projected.negotiation.promises.at(-1)?.id).toBe("promise:33");
    expect(projected.negotiation.evidence.length).toBeLessThanOrEqual(64);
  });
});

describe("Pi model setup", () => {
  it("scales compaction history to the effective context window", () => {
    expect(compactionSettingsForContext(32_768)).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 8_192,
    });
    expect(compactionSettingsForContext(131_072)).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });
  });

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
    const assigned: Array<{
      player: string;
      modelId: string;
      maxTokens: number;
      contextWindow: number;
    }> = [];
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
      contextWindowTokens: 65_536,
      createChannel: async ({ player, model }) => {
        assigned.push({
          player: player.id,
          modelId: model.id,
          maxTokens: model.maxTokens,
          contextWindow: model.contextWindow,
        });
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
      {
        player: "red",
        modelId: "gpt-5.6-luna",
        maxTokens: 128,
        contextWindow: 65_536,
      },
      {
        player: "blue",
        modelId: "deepseek-ai/DeepSeek-V4-Flash",
        maxTokens: 128,
        contextWindow: 65_536,
      },
      {
        player: "white",
        modelId: "gpt-5.6-luna",
        maxTokens: 128,
        contextWindow: 65_536,
      },
      {
        player: "orange",
        modelId: "deepseek-ai/DeepSeek-V4-Flash",
        maxTokens: 128,
        contextWindow: 65_536,
      },
    ]);
    expect(agents.map(({ model }) => model)).toEqual([
      references[0],
      references[1],
      references[0],
      references[1],
    ]);
  });

  it("uses the effective model output capacity when no output override is set", async () => {
    const runtime = await ModelRuntime.create();
    const reference = { provider: "openai", modelId: "gpt-5.6-luna" };
    const nativeModel = runtime.getModel(reference.provider, reference.modelId);
    if (nativeModel === undefined) throw new Error("Expected the Pi model.");
    let assigned:
      | {
          readonly maxTokens: number;
          readonly contextWindow: number;
          readonly turnTimeMs: number;
          readonly finalizationGraceMs: number;
          readonly maxPlanningSteps: number;
        }
      | undefined;
    const factory = createPiAgentFactory({
      models: [reference],
      modelRuntime: runtime,
      contextWindowTokens: 65_536,
      createChannel: async (context) => {
        assigned = {
          maxTokens: context.model.maxTokens,
          contextWindow: context.model.contextWindow,
          turnTimeMs: context.turnTimeMs,
          finalizationGraceMs: context.finalizationGraceMs,
          maxPlanningSteps: context.maxPlanningSteps,
        };
        return {
          async run() {
            return { actionId: "unused" };
          },
          async negotiate() {
            return { action: { type: "pass" } };
          },
          async cancel() {},
          async dispose() {},
        };
      },
    });

    const player = config.players[0];
    if (player === undefined) throw new Error("Expected a player.");
    const agent = await factory(player);
    await agent.dispose();

    expect(assigned).toEqual({
      maxTokens: Math.min(nativeModel.maxTokens, 65_535),
      contextWindow: Math.min(nativeModel.contextWindow, 65_536),
      turnTimeMs: 600_000,
      finalizationGraceMs: 60_000,
      maxPlanningSteps: 8,
    });
  });

  it("rejects invalid turn limits before creating a seat", async () => {
    const runtime = await ModelRuntime.create();
    expect(() =>
      createPiAgentFactory({
        models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
        modelRuntime: runtime,
        turnTimeMs: 0,
      }),
    ).toThrow("turnTimeMs must be a positive integer");
  });

  it("allocates a native Pi session path before the first model request", async () => {
    const sessionDirectory = await mkdtemp(resolve(tmpdir(), "catanarchy-pi-session-"));
    temporaryDirectories.push(sessionDirectory);
    const runtime = await ModelRuntime.create();
    const player = config.players[0];
    if (player === undefined) throw new Error("Expected a player.");
    let sessionFile: string | undefined;
    const factory = createPiAgentFactory({
      models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
      modelRuntime: runtime,
      sessionDirectory,
      onSessionCreated: (_seat, session) => {
        sessionFile = session.sessionFile;
      },
    });

    const agent = await factory(player);
    await agent.dispose();
    const inMemoryAgent = await createPiAgentFactory({
      models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
      modelRuntime: runtime,
      thinkingLevel: "medium",
    })(player);
    await inMemoryAgent.dispose();

    if (sessionFile === undefined) throw new Error("Expected a Pi session path.");
    expect(resolve(sessionFile, "..")).toBe(sessionDirectory);
    expect(sessionFile.endsWith(".jsonl")).toBe(true);
  });

  it("registers the native Pi session created for a seat", async () => {
    const runtime = await ModelRuntime.create();
    const player = config.players[0];
    if (player === undefined) throw new Error("Expected a player.");
    const registered = vi.fn<(player: PlayerConfig, session: PiSessionReference) => void>();
    const factory = createPiAgentFactory({
      models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
      modelRuntime: runtime,
      sessionDirectory: "/tmp/catanarchy-pi-sessions",
      onSessionCreated: registered,
      createChannel: async ({ sessionDirectory }) => ({
        session: {
          sessionId: "session-red",
          sessionFile: `${sessionDirectory}/red.jsonl`,
        },
        async run() {
          return { actionId: "unused" };
        },
        async negotiate() {
          return { action: { type: "pass" } };
        },
        async cancel() {},
        async dispose() {},
      }),
    });

    await factory(player);

    expect(registered).toHaveBeenCalledWith(player, {
      sessionId: "session-red",
      sessionFile: "/tmp/catanarchy-pi-sessions/red.jsonl",
    });
  });

  it("rejects a persistent channel that has no session reference", async () => {
    const runtime = await ModelRuntime.create();
    const player = config.players[0];
    if (player === undefined) throw new Error("Expected a player.");
    const dispose = vi.fn<() => Promise<void>>(async () => {});
    const factory = createPiAgentFactory({
      models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
      modelRuntime: runtime,
      sessionDirectory: "/tmp/catanarchy-pi-sessions",
      createChannel: async () => ({
        async run() {
          return { actionId: "unused" };
        },
        async negotiate() {
          return { action: { type: "pass" } };
        },
        async cancel() {},
        dispose,
      }),
    });

    await expect(factory(player)).rejects.toThrow("did not create a persistent session");
    expect(dispose).toHaveBeenCalledOnce();
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

    const invalidContextFactory = createPiAgentFactory({
      models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
      modelRuntime: runtime,
      contextWindowTokens: 16_384,
    });
    await expect(invalidContextFactory(player)).rejects.toThrow("contextWindowTokens");

    const invalidOutputBudgetFactory = createPiAgentFactory({
      models: [{ provider: "openai", modelId: "gpt-5.6-luna" }],
      modelRuntime: runtime,
      contextWindowTokens: 32_768,
      maxOutputTokens: 32_768,
    });
    await expect(invalidOutputBudgetFactory(player)).rejects.toThrow(
      "smaller than the effective context window",
    );
  });

  it("stops before a Pi request can exceed the run cost ceiling", async () => {
    const budget = new PiCostBudget(1, 0.6);
    const baseAgent: SeatAgent = {
      async decide() {
        return {
          actionId: "action",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0.3 },
        };
      },
      async negotiate() {
        return {
          action: { type: "pass" },
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0.1 },
        };
      },
      async cancel() {},
      async dispose() {},
    };
    const createAgent = withPiCostBudget(async () => baseAgent, budget);
    const agent = await createAgent(config.players[0]!);

    await expect(agent.decide(request())).resolves.toMatchObject({ actionId: "action" });
    if (agent.negotiate === undefined) throw new Error("Expected negotiation support.");
    await expect(agent.negotiate(negotiationRequest())).resolves.toMatchObject({
      action: { type: "pass" },
    });
    expect(budget.snapshot()).toMatchObject({ observedUsd: 0.4 });
    await expect(agent.decide(request())).resolves.toMatchObject({ actionId: "action" });
    await expect(agent.decide(request())).rejects.toBeInstanceOf(AgentRunAbort);
  });

  it("settles reported usage from a failed Pi request", async () => {
    const budget = new PiCostBudget(0.5, 0.2);
    await expect(
      budget.run(async () => {
        throw new AgentDecisionError({
          message: "provider error",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0.4 },
        });
      }),
    ).rejects.toBeInstanceOf(AgentDecisionError);
    expect(budget.snapshot().observedUsd).toBe(0.4);
    await expect(budget.run(async () => ({}))).rejects.toBeInstanceOf(AgentRunAbort);
  });

  it("rejects invalid Pi cost budgets", () => {
    expect(() => new PiCostBudget(0, 0.1)).toThrow("positive finite");
    expect(() => new PiCostBudget(1, 0)).toThrow("positive finite");
    expect(() => new PiCostBudget(1, 2)).toThrow("exceeds");
  });

  it("loads the checked-in V4.1 Novita model definition", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "catanarchy-model-runtime-"));
    temporaryDirectories.push(directory);
    const runtime = await ModelRuntime.create({
      modelsPath: resolve("config/pi-models.json"),
      modelsStorePath: resolve(directory, "models-store.json"),
      authPath: resolve(directory, "auth.json"),
      refreshOnCreate: false,
    });

    expect(runtime.getModel("huggingface", "deepseek-ai/DeepSeek-V4.1-Flash:novita")).toMatchObject(
      {
        contextWindow: 1_048_576,
        maxTokens: 384_000,
        reasoning: true,
        cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      },
    );
  });

  it("pins OpenRouter models to one provider without fallback routing", () => {
    const model = {
      id: "deepseek/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      compat: { supportsDeveloperRole: true },
    };
    const registerProvider = vi.fn<ModelRuntime["registerProvider"]>();
    const runtime = {
      getModel: () => model,
      registerProvider,
    } as unknown as ModelRuntime;
    const references = [
      { provider: "openrouter", modelId: model.id },
      { provider: "openrouter", modelId: model.id },
    ];

    pinOpenRouterProvider(runtime, references, "deepseek");

    expect(registerProvider).toHaveBeenCalledOnce();
    const registration = registerProvider.mock.calls[0];
    expect(registration?.[0]).toBe("openrouter");
    expect(registration?.[1].models).toHaveLength(1);
    expect(registration?.[1].models?.[0]).toMatchObject({
      id: model.id,
      compat: {
        supportsDeveloperRole: true,
        openRouterRouting: { allow_fallbacks: false, only: ["deepseek"] },
      },
    });
    expect(() => pinOpenRouterProvider(runtime, references, "DeepSeek!")).toThrow(
      "lowercase provider slug",
    );
    expect(() =>
      pinOpenRouterProvider(runtime, [{ provider: "huggingface", modelId: "model" }], "novita"),
    ).toThrow("requires at least one OpenRouter model");
    const missingRuntime = {
      getModel: () => undefined,
      registerProvider,
    } as unknown as ModelRuntime;
    expect(() => pinOpenRouterProvider(missingRuntime, references, "deepseek")).toThrow(
      "Unknown Pi model",
    );
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
