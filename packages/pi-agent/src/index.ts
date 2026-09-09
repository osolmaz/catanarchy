import {
  AgentDecisionError,
  type AgentDecision,
  type AgentDecisionRequest,
  type AgentModelIdentity,
  type AgentUsage,
  type SeatAgent,
  type SeatAgentFactory,
} from "@catanarchy/harness";
import type { LegalAction, PlayerConfig } from "@catanarchy/protocol";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface PiModelReference extends AgentModelIdentity {}

export interface PiAgentFactoryOptions {
  readonly models: ReadonlyArray<PiModelReference>;
  readonly modelRuntime: ModelRuntime;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly maxOutputTokens?: number;
  readonly createChannel?: PiDecisionChannelFactory;
}

interface Selection {
  readonly actionId: string;
  readonly reason?: string;
}

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export type PiDecisionChannelFactory = (
  player: PlayerConfig,
  model: PiModel,
  modelRuntime: ModelRuntime,
  thinkingLevel: PiAgentFactoryOptions["thinkingLevel"],
) => Promise<PiDecisionChannel>;

type ToolResult = {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly terminate?: boolean;
};

export class ActionSelectionGate {
  private legalActionIds = new Set<string>();
  private selection: Selection | undefined;
  private failed = false;

  begin(legalActionIds: ReadonlyArray<string>): void {
    this.legalActionIds = new Set(legalActionIds);
    this.selection = undefined;
    this.failed = false;
  }

  choose(actionId: string, reason?: string): ToolResult {
    if (this.failed || !this.legalActionIds.has(actionId)) {
      this.selection = undefined;
      this.failed = true;
      return {
        content: [
          { type: "text", text: "The action is invalid or this decision attempt already failed." },
        ],
        details: { accepted: false },
        isError: true,
        terminate: true,
      };
    }
    if (this.selection !== undefined) {
      this.selection = undefined;
      this.failed = true;
      return {
        content: [{ type: "text", text: "An action was already selected for this decision." }],
        details: { accepted: false },
        isError: true,
        terminate: true,
      };
    }
    this.selection = { actionId, ...(reason === undefined ? {} : { reason }) };
    return {
      content: [{ type: "text", text: `Selected ${actionId}.` }],
      details: { accepted: true, actionId },
      terminate: true,
    };
  }

  take(): Selection | undefined {
    const selection = this.failed ? undefined : this.selection;
    this.selection = undefined;
    this.failed = false;
    return selection;
  }
}

export interface PiDecisionChannel {
  run(
    prompt: string,
    legalActionIds: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<AgentDecision>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export const selectActionFromText = (
  text: string,
  legalActionIds: ReadonlyArray<string>,
): Selection | undefined => {
  const matches = legalActionIds.filter((actionId) => text.includes(actionId));
  return matches.length === 1 && matches[0] !== undefined ? { actionId: matches[0] } : undefined;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isTextPart = (value: unknown): value is { readonly type: "text"; readonly text: string } =>
  isRecord(value) && value["type"] === "text" && typeof value["text"] === "string";

export const extractAssistantText = (messages: ReadonlyArray<unknown>): string => {
  for (const message of messages.toReversed()) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    return content
      .filter((part: unknown) => isTextPart(part))
      .map(({ text }) => text)
      .join("\n");
  }
  return "";
};

const usageDifference = (before: SessionStats, after: SessionStats): AgentUsage => ({
  input: after.tokens.input - before.tokens.input,
  output: after.tokens.output - before.tokens.output,
  cacheRead: after.tokens.cacheRead - before.tokens.cacheRead,
  cacheWrite: after.tokens.cacheWrite - before.tokens.cacheWrite,
  total: after.tokens.total - before.tokens.total,
  cost: after.cost - before.cost,
});

const emptyResourceLoader = (systemPrompt: string): ResourceLoader => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
});

const systemPromptFor = (
  player: PlayerConfig,
): string => `You control the ${player.name} seat in a Catan game.
Use only the observation and legal actions in the current request.
Choose strategically, but do not invent hidden state or commands.
Call choose_action exactly once with one listed actionId.
The reason is optional and must be one short sentence.`;

class SdkDecisionChannel implements PiDecisionChannel {
  readonly #session: AgentSession;
  readonly #gate: ActionSelectionGate;

  constructor(session: AgentSession, gate: ActionSelectionGate) {
    this.#session = session;
    this.#gate = gate;
  }

  async run(
    prompt: string,
    legalActionIds: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<AgentDecision> {
    this.#gate.begin(legalActionIds);
    const before = this.#session.getSessionStats();
    const abort = async (): Promise<void> => this.#session.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.#session.prompt(prompt, { expandPromptTemplates: false });
    } catch (error) {
      throw new AgentDecisionError({
        message: error instanceof Error ? error.message : "The model request failed.",
        usage: usageDifference(before, this.#session.getSessionStats()),
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
    const usage = usageDifference(before, this.#session.getSessionStats());
    const toolSelection = this.#gate.take();
    const responseText = extractAssistantText(this.#session.messages);
    const textSelection = selectActionFromText(responseText, legalActionIds);
    const selection = toolSelection ?? textSelection;
    if (selection === undefined) {
      const preview = responseText.replaceAll(/\s+/g, " ").trim().slice(0, 300);
      throw new AgentDecisionError({
        message:
          preview.length === 0
            ? "The model did not select a legal action and returned no text."
            : `The model did not select a legal action. Response: ${preview}`,
        usage,
      });
    }
    return {
      ...selection,
      selectionMode: toolSelection === undefined ? "text" : "tool",
      usage,
    };
  }

  async cancel(): Promise<void> {
    await this.#session.abort();
  }

  async dispose(): Promise<void> {
    this.#session.dispose();
  }
}

const createSdkDecisionChannel = async (
  player: PlayerConfig,
  model: PiModel,
  modelRuntime: ModelRuntime,
  thinkingLevel: PiAgentFactoryOptions["thinkingLevel"],
): Promise<PiDecisionChannel> => {
  const gate = new ActionSelectionGate();
  const chooseAction = defineTool({
    name: "choose_action",
    label: "Choose action",
    description: "Select one action ID from the current legal-action list and finish the decision.",
    promptSnippet: "Select one legal Catan action and finish the decision",
    promptGuidelines: [
      "Call choose_action exactly once with an actionId from the current request.",
    ],
    parameters: Type.Object({
      actionId: Type.String({ description: "One exact actionId from the legalActions list" }),
      reason: Type.Optional(Type.String({ description: "One short strategic reason" })),
    }),
    execute: async (_toolCallId, parameters) => gate.choose(parameters.actionId, parameters.reason),
  });
  const cwd = process.cwd();
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    thinkingLevel: thinkingLevel ?? "low",
    resourceLoader: emptyResourceLoader(systemPromptFor(player)),
    tools: ["choose_action"],
    customTools: [chooseAction],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });
  return new SdkDecisionChannel(session, gate);
};

const harborKindsAtVertex = (
  action: LegalAction,
  observation: AgentDecisionRequest["observation"],
): ReadonlyArray<string> => {
  if (action.command.command.type !== "place-initial-settlement") {
    return [];
  }
  const vertexId = action.command.command.vertexId;
  const vertex = observation.topology.vertices.find(({ id }) => id === vertexId);
  if (vertex === undefined) {
    return [];
  }
  const edgeIds = new Set(vertex.edgeIds);
  return observation.layout.harbors
    .filter(({ edgeId }) => edgeIds.has(edgeId))
    .map(({ kind }) => kind);
};

const describeAction = (
  action: LegalAction,
  observation: AgentDecisionRequest["observation"],
): Readonly<Record<string, unknown>> => {
  const command = action.command.command;
  if (command.type === "place-initial-road") {
    const edge = observation.topology.edges.find(({ id }) => id === command.edgeId);
    return {
      actionId: action.id,
      type: command.type,
      edgeId: command.edgeId,
      endpoints: edge?.vertexIds ?? [],
    };
  }
  const vertex = observation.topology.vertices.find(({ id }) => id === command.vertexId);
  const terrain = new Map(observation.layout.terrain.map((item) => [item.hexId, item.terrain]));
  const numbers = new Map(observation.layout.numbers.map((item) => [item.hexId, item.number]));
  return {
    actionId: action.id,
    type: command.type,
    vertexId: command.vertexId,
    adjacentHexes: (vertex?.adjacentHexIds ?? []).map((hexId) => ({
      hexId,
      terrain: terrain.get(hexId),
      number: numbers.get(hexId) ?? null,
    })),
    harbors: harborKindsAtVertex(action, observation),
  };
};

export const buildDecisionPrompt = (request: AgentDecisionRequest): string =>
  JSON.stringify(
    {
      task: "Choose one legal initial-placement action and call choose_action.",
      matchId: request.matchId,
      sequence: request.sequence,
      playerId: request.playerId,
      phase: request.observation.phase,
      activePlayerId: request.observation.activePlayerId,
      players: request.observation.players,
      ownResources: request.observation.ownResources,
      occupiedBuildings: request.observation.occupancy.buildings,
      occupiedRoads: request.observation.occupancy.roads,
      legalActions: request.legalActions.map((action) =>
        describeAction(action, request.observation),
      ),
    },
    undefined,
    2,
  );

export const createPiSeatAgent = (
  model: PiModelReference,
  channel: PiDecisionChannel,
): SeatAgent => ({
  model,
  async decide(request) {
    return channel.run(
      buildDecisionPrompt(request),
      request.legalActions.map(({ id }) => id),
      request.signal,
    );
  },
  async cancel() {
    await channel.cancel();
  },
  async dispose() {
    await channel.dispose();
  },
});

export const parseModelReference = (reference: string): PiModelReference => {
  const separator = reference.indexOf("/");
  if (separator < 1 || separator === reference.length - 1) {
    throw new Error(`Invalid model reference: ${reference}`);
  }
  return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
};

export const createPiAgentFactory = (options: PiAgentFactoryOptions): SeatAgentFactory => {
  if (options.models.length === 0) {
    throw new Error("At least one Pi model is required.");
  }
  let seatIndex = 0;
  return async (player) => {
    const reference = options.models[seatIndex % options.models.length];
    seatIndex += 1;
    if (reference === undefined) {
      throw new Error("No Pi model is assigned to the seat.");
    }
    const model = options.modelRuntime.getModel(reference.provider, reference.modelId);
    if (model === undefined) {
      throw new Error(`Unknown Pi model: ${reference.provider}/${reference.modelId}`);
    }
    const maxOutputTokens = options.maxOutputTokens ?? 4_096;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
      throw new Error("maxOutputTokens must be a positive integer.");
    }
    const boundedModel: PiModel = {
      ...model,
      maxTokens: Math.min(model.maxTokens, maxOutputTokens),
    };
    const channel = await (options.createChannel ?? createSdkDecisionChannel)(
      player,
      boundedModel,
      options.modelRuntime,
      options.thinkingLevel,
    );
    return createPiSeatAgent(reference, channel);
  };
};

export const applyEnvironmentAuthentication = async (
  runtime: ModelRuntime,
  references: ReadonlyArray<PiModelReference>,
): Promise<void> => {
  const environmentNames: Readonly<Record<string, string>> = {
    openai: "OPENAI_API_KEY",
    huggingface: "HF_TOKEN",
  };
  for (const provider of new Set(references.map(({ provider }) => provider))) {
    const environmentName = environmentNames[provider];
    const credential = environmentName === undefined ? undefined : process.env[environmentName];
    if (credential !== undefined && credential.length > 0) {
      await runtime.setRuntimeApiKey(provider, credential);
    }
  }
};

export const assertModelsAvailable = async (
  runtime: ModelRuntime,
  references: ReadonlyArray<PiModelReference>,
): Promise<void> => {
  for (const reference of references) {
    const model = runtime.getModel(reference.provider, reference.modelId);
    if (model === undefined) {
      throw new Error(`Unknown Pi model: ${reference.provider}/${reference.modelId}`);
    }
    if ((await runtime.getAuth(model)) === undefined) {
      throw new Error(`Authentication is not configured for provider ${reference.provider}.`);
    }
  }
};

export { ModelRuntime };
