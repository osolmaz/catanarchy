import { readFile } from "node:fs/promises";
import {
  AgentDecisionError,
  AgentRunAbort,
  type AgentDecision,
  type AgentDecisionRequest,
  type AgentModelIdentity,
  type AgentNegotiationDecision,
  type AgentNegotiationRequest,
  type AgentUsage,
  type SeatAgent,
  type SeatAgentFactory,
} from "@catanarchy/harness";
import {
  decodeNegotiationAction,
  type LegalAction,
  type NegotiationAction,
  type NegotiationScope,
  type PlayerConfig,
} from "@catanarchy/protocol";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
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
import { Effect, Either } from "effect";
import { Type, type Static } from "typebox";

export interface PiModelReference extends AgentModelIdentity {}

/**
 * The thinking levels a run accepts. Pi supports these seven levels, and the
 * bundled model store maps each of them for the models this harness runs. The
 * list is the single source for both the option type and the `--thinking`
 * argument, so a new level reaches both.
 */
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface PiAgentFactoryOptions {
  readonly models: ReadonlyArray<PiModelReference>;
  readonly modelRuntime: ModelRuntime;
  readonly thinkingLevel?: PiThinkingLevel;
  readonly maxOutputTokens?: number;
  readonly contextWindowTokens?: number;
  readonly turnTimeMs?: number;
  readonly finalizationGraceMs?: number;
  readonly maxPlanningSteps?: number;
  readonly sessionDirectory?: string;
  /**
   * Absolute session files to restore, keyed by seat. A warm resume restores the
   * seat memory from the file that the run manifest already records.
   */
  readonly resumedSessions?: ReadonlyMap<string, string>;
  readonly onSessionCreated?: (
    player: PlayerConfig,
    session: PiSessionReference,
  ) => void | Promise<void>;
  readonly createChannel?: PiDecisionChannelFactory;
}

interface Selection {
  readonly actionId: string;
  readonly reason?: string;
}

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface PiSessionReference {
  readonly sessionId: string;
  readonly sessionFile: string;
}

export interface PiDecisionChannelContext {
  readonly player: PlayerConfig;
  readonly model: PiModel;
  readonly modelRuntime: ModelRuntime;
  readonly thinkingLevel: PiAgentFactoryOptions["thinkingLevel"];
  readonly turnTimeMs: number;
  readonly finalizationGraceMs: number;
  readonly maxPlanningSteps: number;
  readonly sessionDirectory?: string;
  readonly resumedSessionFile?: string;
}

export type PiDecisionChannelFactory = (
  context: PiDecisionChannelContext,
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
  private active = false;
  private failed = false;

  begin(legalActionIds: ReadonlyArray<string>): void {
    this.legalActionIds = new Set(legalActionIds);
    this.selection = undefined;
    this.active = true;
    this.failed = false;
  }

  disable(): void {
    this.legalActionIds.clear();
    this.selection = undefined;
    this.active = false;
    this.failed = false;
  }

  choose(actionId: string, reason?: string): ToolResult {
    if (!this.active || this.failed || !this.legalActionIds.has(actionId)) {
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

  isPoisoned(): boolean {
    return this.failed;
  }

  isComplete(): boolean {
    return this.failed || this.selection !== undefined;
  }

  take(): Selection | undefined {
    const selection = this.failed ? undefined : this.selection;
    this.selection = undefined;
    this.active = false;
    this.failed = false;
    return selection;
  }
}

interface NegotiationSelection {
  readonly action: NegotiationAction;
  readonly reason?: string;
}

export class NegotiationSelectionGate {
  private selection: NegotiationSelection | undefined;
  private active = false;
  private failed = false;

  begin(): void {
    this.selection = undefined;
    this.active = true;
    this.failed = false;
  }

  disable(): void {
    this.selection = undefined;
    this.active = false;
    this.failed = false;
  }

  choose(action: NegotiationAction | undefined, reason?: string): ToolResult {
    if (!this.active || this.failed || action === undefined) {
      this.selection = undefined;
      this.failed = true;
      return {
        content: [{ type: "text", text: "The negotiation operation is invalid." }],
        details: { accepted: false },
        isError: true,
        terminate: true,
      };
    }
    if (this.selection !== undefined) {
      this.selection = undefined;
      this.failed = true;
      return {
        content: [{ type: "text", text: "A negotiation operation was already selected." }],
        details: { accepted: false },
        isError: true,
        terminate: true,
      };
    }
    this.selection = { action, ...(reason === undefined ? {} : { reason }) };
    return {
      content: [{ type: "text", text: `Selected negotiation operation ${action.type}.` }],
      details: { accepted: true, actionType: action.type },
      terminate: true,
    };
  }

  isPoisoned(): boolean {
    return this.failed;
  }

  isComplete(): boolean {
    return this.failed || this.selection !== undefined;
  }

  take(): NegotiationSelection | undefined {
    const selection = this.failed ? undefined : this.selection;
    this.selection = undefined;
    this.active = false;
    this.failed = false;
    return selection;
  }
}

export interface PiDecisionChannel {
  readonly session?: PiSessionReference;
  run(request: AgentDecisionRequest): Promise<AgentDecision>;
  negotiate(request: AgentNegotiationRequest): Promise<AgentNegotiationDecision>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

const INSPECTION_SECTIONS = [
  "status",
  "board",
  "players",
  "inventory",
  "legal-actions",
  "negotiation",
] as const;
type InspectionSection = (typeof INSPECTION_SECTIONS)[number];
type InspectionSections = Readonly<Partial<Record<InspectionSection, unknown>>>;

type TurnPhase = "exploration" | "finalization";

export class TurnBudget {
  private turnKey: string | undefined;
  private explorationUsedMs = 0;
  private finalizationUsedMs = 0;
  private planningSteps = 0;
  private readonly sentWarnings = new Set<number>();

  constructor(
    readonly explorationLimitMs: number,
    readonly finalizationLimitMs: number,
    readonly planningStepLimit: number,
  ) {}

  begin(turnKey: string): void {
    if (this.turnKey === turnKey) return;
    this.turnKey = turnKey;
    this.explorationUsedMs = 0;
    this.finalizationUsedMs = 0;
    this.planningSteps = 0;
    this.sentWarnings.clear();
  }

  /**
   * Start one decision of the current turn. The turn clock continues, because it bounds
   * the whole turn, and the finalization grace starts again, because it bounds one
   * answer. A turn with six decisions therefore does not share one grace between them.
   */
  startDecision(): void {
    this.finalizationUsedMs = 0;
  }

  remaining(phase: TurnPhase): number {
    const used = phase === "exploration" ? this.explorationUsedMs : this.finalizationUsedMs;
    const limit = phase === "exploration" ? this.explorationLimitMs : this.finalizationLimitMs;
    return Math.max(0, limit - used);
  }

  consume(phase: TurnPhase, elapsedMs: number): void {
    if (phase === "exploration") this.explorationUsedMs += elapsedMs;
    else this.finalizationUsedMs += elapsedMs;
  }

  takePlanningStep(): boolean {
    if (this.planningSteps >= this.planningStepLimit) return false;
    this.planningSteps += 1;
    return true;
  }

  warningDelays(): ReadonlyArray<{ readonly thresholdMs: number; readonly delayMs: number }> {
    const used = this.explorationUsedMs;
    const thresholds = [
      Math.round(this.explorationLimitMs / 2),
      Math.max(0, this.explorationLimitMs - 10_000),
    ];
    return [...new Set(thresholds)]
      .filter(
        (thresholdMs) =>
          thresholdMs > used &&
          thresholdMs < this.explorationLimitMs &&
          !this.sentWarnings.has(thresholdMs),
      )
      .map((thresholdMs) => ({ thresholdMs, delayMs: thresholdMs - used }));
  }

  markWarning(thresholdMs: number): void {
    this.sentWarnings.add(thresholdMs);
  }
}

export class InspectionGate {
  private sections: InspectionSections = {};
  private budget: TurnBudget | undefined;
  private active = false;
  private complete = false;

  begin(sections: InspectionSections, budget: TurnBudget): void {
    this.sections = sections;
    this.budget = budget;
    this.active = true;
    this.complete = false;
  }

  disable(): void {
    this.sections = {};
    this.budget = undefined;
    this.active = false;
    this.complete = false;
  }

  isComplete(): boolean {
    return this.complete;
  }

  inspect(section: InspectionSection): ToolResult {
    if (!this.active || this.budget === undefined) {
      return {
        content: [{ type: "text", text: "Inspection is unavailable during finalization." }],
        details: { section, accepted: false },
        isError: true,
      };
    }
    if (!this.budget.takePlanningStep()) {
      this.complete = true;
      return {
        content: [{ type: "text", text: "The planning-message limit is complete. Select now." }],
        details: { section, accepted: false },
        isError: true,
        terminate: true,
      };
    }
    const value = this.sections[section];
    if (value === undefined) {
      return {
        content: [{ type: "text", text: `Section ${section} is unavailable for this request.` }],
        details: { section, accepted: false },
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      details: { section, accepted: true },
    };
  }
}

export const selectActionFromText = (
  text: string,
  legalActionIds: ReadonlyArray<string>,
): Selection | undefined => {
  const matches = legalActionIds.filter((actionId) => text.includes(actionId));
  return matches.length === 1 && matches[0] !== undefined ? { actionId: matches[0] } : undefined;
};

export const resolveSelection = (
  gate: ActionSelectionGate,
  responseText: string,
  legalActionIds: ReadonlyArray<string>,
  allowText = true,
): { readonly selection: Selection | undefined; readonly selectionMode: "tool" | "text" } => {
  const poisoned = gate.isPoisoned();
  const toolSelection = gate.take();
  const textSelection =
    poisoned || !allowText ? undefined : selectActionFromText(responseText, legalActionIds);
  return {
    selection: toolSelection ?? textSelection,
    selectionMode: toolSelection === undefined ? "text" : "tool",
  };
};

const ResourceCountsParameters = Type.Object({
  lumber: Type.Integer({ minimum: 0 }),
  brick: Type.Integer({ minimum: 0 }),
  wool: Type.Integer({ minimum: 0 }),
  grain: Type.Integer({ minimum: 0 }),
  ore: Type.Integer({ minimum: 0 }),
});

const NegotiationToolParameters = Type.Object({
  operation: StringEnum([
    "pass",
    "send-message",
    "make-offer",
    "counter-offer",
    "accept-offer",
    "reject-offer",
    "withdraw-offer",
    "record-promise",
    "record-promise-evidence",
  ] as const),
  scope: Type.Optional(StringEnum(["public", "direct"] as const)),
  scopePlayerId: Type.Optional(
    Type.String({ description: "Recipient for a directed message, offer, or promise" }),
  ),
  text: Type.Optional(Type.String()),
  targetPlayerId: Type.Optional(
    Type.String({
      description:
        "Required for every make-offer operation, including a public offer; use another player ID",
    }),
  ),
  offerId: Type.Optional(Type.String()),
  give: Type.Optional(ResourceCountsParameters),
  receive: Type.Optional(ResourceCountsParameters),
  beneficiaryPlayerId: Type.Optional(Type.String()),
  relatedOfferId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  promiseId: Type.Optional(Type.String()),
  gameSequence: Type.Optional(Type.Integer({ minimum: 0 })),
  reason: Type.Optional(Type.String({ description: "One short strategic reason" })),
});

type NegotiationToolInput = Static<typeof NegotiationToolParameters>;
type NegotiationOperation = NegotiationToolInput["operation"];
type NegotiationActionBuilder = (input: NegotiationToolInput) => unknown;

const scopeFromToolInput = (input: NegotiationToolInput): NegotiationScope | undefined =>
  input.scope === "public"
    ? { type: "public" }
    : input.scope === "direct" && input.scopePlayerId !== undefined
      ? { type: "direct", playerId: input.scopePlayerId }
      : undefined;

const NEGOTIATION_ACTION_BUILDERS: Readonly<
  Record<NegotiationOperation, NegotiationActionBuilder>
> = {
  pass: () => ({ type: "pass" }),
  "send-message": (input) => ({
    type: "send-message",
    scope: scopeFromToolInput(input),
    text: input.text,
  }),
  "make-offer": (input) => ({
    type: "make-offer",
    targetPlayerId: input.targetPlayerId,
    scope: scopeFromToolInput(input),
    give: input.give,
    receive: input.receive,
  }),
  "counter-offer": (input) => ({
    type: "counter-offer",
    offerId: input.offerId,
    scope: scopeFromToolInput(input),
    give: input.give,
    receive: input.receive,
  }),
  "accept-offer": (input) => ({ type: "accept-offer", offerId: input.offerId }),
  "reject-offer": (input) => ({ type: "reject-offer", offerId: input.offerId }),
  "withdraw-offer": (input) => ({ type: "withdraw-offer", offerId: input.offerId }),
  "record-promise": (input) => ({
    type: "record-promise",
    beneficiaryPlayerId: input.beneficiaryPlayerId,
    scope: scopeFromToolInput(input),
    text: input.text,
    relatedOfferId: input.relatedOfferId ?? null,
  }),
  "record-promise-evidence": (input) => ({
    type: "record-promise-evidence",
    promiseId: input.promiseId,
    gameSequence: input.gameSequence,
    text: input.text,
  }),
};

export const negotiationActionFromToolInput = (
  input: NegotiationToolInput,
): NegotiationAction | undefined => {
  const candidate = NEGOTIATION_ACTION_BUILDERS[input.operation](input);
  const decoded = Effect.runSync(Effect.either(decodeNegotiationAction(candidate)));
  return Either.isRight(decoded) ? decoded.right : undefined;
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

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const jsonCandidates = (text: string): ReadonlyArray<string> => {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed)?.[1]?.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const embedded =
    firstBrace >= 0 && lastBrace > firstBrace
      ? trimmed.slice(firstBrace, lastBrace + 1)
      : undefined;
  return [...new Set([trimmed, fenced, embedded].filter((value) => value !== undefined))];
};

export const selectNegotiationFromText = (text: string): NegotiationAction | undefined => {
  for (const candidate of jsonCandidates(text)) {
    const parsed = parseJson(candidate);
    const value = isRecord(parsed) && "action" in parsed ? parsed["action"] : parsed;
    const decoded = Effect.runSync(Effect.either(decodeNegotiationAction(value)));
    if (Either.isRight(decoded)) return decoded.right;
  }
  return undefined;
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
Use only information in the current request and prior authorized messages in this session.
Choose strategically, but do not invent hidden state, commands, offers, or resource cards.
You may call inspect_game several times while planning. Each inspection uses turn time.
For a game-action request, finish by calling choose_action exactly once. Copy its actionId exactly from the current legalActions list; never infer an actionId from the board.
For a negotiation request, finish by calling choose_negotiation exactly once with one valid operation. Every make-offer operation requires targetPlayerId, including a public offer.
Do not call the other selection tool. The reason is optional and must be one short sentence.`;

interface PromptPhaseResult {
  readonly responseText: string;
  readonly timedOut: boolean;
}

interface ResolvedGamePhase {
  readonly resolved: ReturnType<typeof resolveSelection>;
  readonly poisoned: boolean;
}

const resolveGamePhase = (
  actionGate: ActionSelectionGate,
  negotiationGate: NegotiationSelectionGate,
  phase: PromptPhaseResult,
  legalActionIds: ReadonlyArray<string>,
): ResolvedGamePhase => {
  const wrongTool = negotiationGate.isPoisoned();
  negotiationGate.take();
  const poisoned = actionGate.isPoisoned() || wrongTool;
  if (wrongTool) {
    actionGate.take();
    return {
      resolved: { selection: undefined, selectionMode: "text" },
      poisoned,
    };
  }
  return {
    resolved: resolveSelection(actionGate, phase.responseText, legalActionIds, !phase.timedOut),
    poisoned,
  };
};

interface ResolvedNegotiationPhase {
  readonly selection: NegotiationSelection | undefined;
  readonly selectionMode: "tool" | "text";
  readonly poisoned: boolean;
}

const resolveNegotiationPhase = (
  actionGate: ActionSelectionGate,
  negotiationGate: NegotiationSelectionGate,
  phase: PromptPhaseResult,
): ResolvedNegotiationPhase => {
  const wrongTool = actionGate.isPoisoned();
  actionGate.take();
  const poisoned = negotiationGate.isPoisoned() || wrongTool;
  const toolSelection = negotiationGate.take();
  const textSelection =
    wrongTool || poisoned || phase.timedOut
      ? undefined
      : selectNegotiationFromText(phase.responseText);
  return {
    selection:
      toolSelection ?? (textSelection === undefined ? undefined : { action: textSelection }),
    selectionMode: toolSelection === undefined ? "text" : "tool",
    poisoned,
  };
};

const decisionErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The model request failed.";

/**
 * A seat ran out of one of its two time pools. The pool name and the time it had left
 * travel with the error, so the run record states that a pool ran dry instead of only
 * that the decision failed.
 */
export class PhaseExhaustedError extends Error {
  constructor(
    message: string,
    readonly pool: TurnPhase,
    readonly remainingMs: number,
  ) {
    super(message);
  }
}

/**
 * The pool detail a seat reports for a failed decision. It is empty unless one of the two
 * time pools was already empty, which is the failure that spends no model tokens.
 */
export const timePoolDetailOf = (
  error: unknown,
): { readonly pool?: TurnPhase; readonly remainingMs?: number } =>
  error instanceof PhaseExhaustedError ? { pool: error.pool, remainingMs: error.remainingMs } : {};

const noSelectionError = (
  phase: PromptPhaseResult,
  pool: TurnPhase,
  remainingMs: number,
  timedOutMessage: string,
  settledMessage: string,
): Error =>
  new PhaseExhaustedError(phase.timedOut ? timedOutMessage : settledMessage, pool, remainingMs);

class SdkDecisionChannel implements PiDecisionChannel {
  readonly #session: AgentSession;
  readonly #actionGate: ActionSelectionGate;
  readonly #negotiationGate: NegotiationSelectionGate;
  readonly #inspectionGate: InspectionGate;
  readonly #turnBudget: TurnBudget;

  constructor(
    session: AgentSession,
    actionGate: ActionSelectionGate,
    negotiationGate: NegotiationSelectionGate,
    inspectionGate: InspectionGate,
    turnBudget: TurnBudget,
  ) {
    this.#session = session;
    this.#actionGate = actionGate;
    this.#negotiationGate = negotiationGate;
    this.#inspectionGate = inspectionGate;
    this.#turnBudget = turnBudget;
  }

  async #promptPhase(
    prompt: string,
    signal: AbortSignal,
    phase: TurnPhase,
  ): Promise<PromptPhaseResult> {
    const remainingMs = this.#turnBudget.remaining(phase);
    if (remainingMs === 0) return { responseText: "", timedOut: true };

    signal.throwIfAborted();
    const warningTimers =
      phase === "exploration"
        ? this.#turnBudget.warningDelays().map(({ thresholdMs, delayMs }) =>
            setTimeout(() => {
              if (
                this.#actionGate.isComplete() ||
                this.#negotiationGate.isComplete() ||
                this.#inspectionGate.isComplete()
              ) {
                return;
              }
              this.#turnBudget.markWarning(thresholdMs);
              this.#session.clearQueue();
              const seconds = Math.max(
                0,
                Math.ceil((this.#turnBudget.explorationLimitMs - thresholdMs) / 1_000),
              );
              void this.#session
                .steer(`[Turn clock] ${String(seconds)} seconds remain. Select soon.`)
                .catch(() => undefined);
            }, delayMs),
          )
        : [];
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    let consumed = false;
    const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
    });
    const promptRun = this.#session.prompt(prompt, { expandPromptTemplates: false }).then(
      () => ({ kind: "settled" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    const abort = (): void => {
      void this.#session.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const outcome = await Promise.race([promptRun, timeout]);
      this.#turnBudget.consume(phase, performance.now() - startedAt);
      consumed = true;
      if (outcome.kind === "failed") throw outcome.error;
      if (outcome.kind === "timeout") {
        await this.#session.abort();
        await this.#session.waitForIdle();
      }
      return {
        responseText: extractAssistantText(this.#session.messages),
        timedOut: outcome.kind === "timeout",
      };
    } finally {
      if (!consumed) this.#turnBudget.consume(phase, performance.now() - startedAt);
      if (timer !== undefined) clearTimeout(timer);
      for (const warningTimer of warningTimers) clearTimeout(warningTimer);
      signal.removeEventListener("abort", abort);
    }
  }

  async run(request: AgentDecisionRequest): Promise<AgentDecision> {
    const before = this.#session.getSessionStats();
    const legalActionIds = request.legalActions.map(({ id }) => id);
    this.#turnBudget.begin(request.turnKey);
    this.#turnBudget.startDecision();
    this.#actionGate.begin(legalActionIds);
    this.#negotiationGate.disable();
    this.#inspectionGate.begin(inspectionSections(request), this.#turnBudget);
    try {
      const exploration = await this.#promptPhase(
        buildDecisionPrompt(request),
        request.signal,
        "exploration",
      );
      const explorationResult = resolveGamePhase(
        this.#actionGate,
        this.#negotiationGate,
        exploration,
        legalActionIds,
      );
      if (explorationResult.resolved.selection !== undefined) {
        return {
          ...explorationResult.resolved.selection,
          selectionMode: explorationResult.resolved.selectionMode,
          usage: usageDifference(before, this.#session.getSessionStats()),
        };
      }
      if (explorationResult.poisoned) {
        throw new Error("The model called an invalid selection tool.");
      }

      this.#inspectionGate.disable();
      this.#actionGate.begin(legalActionIds);
      const finalization = await this.#promptPhase(
        gameFinalizationPrompt(legalActionIds, exploration.timedOut),
        request.signal,
        "finalization",
      );
      const finalized = resolveGamePhase(
        this.#actionGate,
        this.#negotiationGate,
        finalization,
        legalActionIds,
      ).resolved;
      if (finalized.selection === undefined) {
        throw noSelectionError(
          finalization,
          "finalization",
          this.#turnBudget.remaining("finalization"),
          "The game-action finalization time expired.",
          "The model did not select a legal action during finalization.",
        );
      }
      return {
        ...finalized.selection,
        selectionMode: finalized.selectionMode,
        usage: usageDifference(before, this.#session.getSessionStats()),
      };
    } catch (error) {
      throw new AgentDecisionError({
        message: decisionErrorMessage(error),
        usage: usageDifference(before, this.#session.getSessionStats()),
        ...timePoolDetailOf(error),
      });
    } finally {
      this.#inspectionGate.disable();
    }
  }

  async negotiate(request: AgentNegotiationRequest): Promise<AgentNegotiationDecision> {
    const before = this.#session.getSessionStats();
    this.#turnBudget.begin(request.turnKey);
    this.#turnBudget.startDecision();
    this.#actionGate.disable();
    this.#negotiationGate.begin();
    this.#inspectionGate.begin(inspectionSections(request), this.#turnBudget);
    try {
      const exploration = await this.#promptPhase(
        buildNegotiationPrompt(request),
        request.signal,
        "exploration",
      );
      const explorationResult = resolveNegotiationPhase(
        this.#actionGate,
        this.#negotiationGate,
        exploration,
      );
      if (explorationResult.selection !== undefined) {
        return {
          ...explorationResult.selection,
          selectionMode: explorationResult.selectionMode,
          usage: usageDifference(before, this.#session.getSessionStats()),
        };
      }
      if (explorationResult.poisoned) {
        throw new Error("The model called an invalid selection tool.");
      }

      this.#inspectionGate.disable();
      this.#negotiationGate.begin();
      const finalization = await this.#promptPhase(
        negotiationFinalizationPrompt(exploration.timedOut),
        request.signal,
        "finalization",
      );
      const finalized = resolveNegotiationPhase(
        this.#actionGate,
        this.#negotiationGate,
        finalization,
      );
      if (finalized.selection === undefined) {
        throw noSelectionError(
          finalization,
          "finalization",
          this.#turnBudget.remaining("finalization"),
          "The negotiation finalization time expired.",
          "The model did not select a negotiation operation during finalization.",
        );
      }
      return {
        ...finalized.selection,
        selectionMode: finalized.selectionMode,
        usage: usageDifference(before, this.#session.getSessionStats()),
      };
    } catch (error) {
      throw new AgentDecisionError({
        message: decisionErrorMessage(error),
        usage: usageDifference(before, this.#session.getSessionStats()),
        ...timePoolDetailOf(error),
      });
    } finally {
      this.#inspectionGate.disable();
    }
  }

  async cancel(): Promise<void> {
    await this.#session.abort();
  }

  async dispose(): Promise<void> {
    this.#session.dispose();
  }
}

export const compactionSettingsForContext = (
  contextWindow: number,
): {
  readonly enabled: true;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
} => {
  const reserveTokens = Math.min(16_384, Math.floor(contextWindow / 2));
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens: Math.min(20_000, Math.floor((contextWindow - reserveTokens) / 2)),
  };
};

const sessionManagerFor = (
  cwd: string,
  sessionDirectory: string | undefined,
  resumedSessionFile: string | undefined,
): SessionManager => {
  if (resumedSessionFile !== undefined) {
    return sessionDirectory === undefined
      ? SessionManager.open(resumedSessionFile)
      : SessionManager.open(resumedSessionFile, sessionDirectory);
  }
  return sessionDirectory === undefined
    ? SessionManager.inMemory(cwd)
    : SessionManager.create(cwd, sessionDirectory);
};

const createSdkDecisionChannel = async ({
  player,
  model,
  modelRuntime,
  thinkingLevel,
  turnTimeMs,
  finalizationGraceMs,
  maxPlanningSteps,
  sessionDirectory,
  resumedSessionFile,
}: PiDecisionChannelContext): Promise<PiDecisionChannel> => {
  const actionGate = new ActionSelectionGate();
  const negotiationGate = new NegotiationSelectionGate();
  const inspectionGate = new InspectionGate();
  const turnBudget = new TurnBudget(turnTimeMs, finalizationGraceMs, maxPlanningSteps);
  let sdkSession: AgentSession | undefined;
  const clearQueueOnTermination = (result: ToolResult): ToolResult => {
    if (result.terminate === true) sdkSession?.clearQueue();
    return result;
  };
  const chooseAction = defineTool({
    name: "choose_action",
    label: "Choose action",
    description: "Select one action ID from the current legal-action list and finish the decision.",
    promptSnippet: "Select one legal Catan action and finish the decision",
    promptGuidelines: [
      "Call choose_action exactly once and copy actionId exactly from the current legalActions list; never infer an actionId from the board.",
    ],
    parameters: Type.Object({
      actionId: Type.String({ description: "One exact actionId from the legalActions list" }),
      reason: Type.Optional(Type.String({ description: "One short strategic reason" })),
    }),
    execute: async (_toolCallId, parameters) =>
      clearQueueOnTermination(actionGate.choose(parameters.actionId, parameters.reason)),
  });
  const chooseNegotiation = defineTool({
    name: "choose_negotiation",
    label: "Choose negotiation operation",
    description:
      "Submit one Catan negotiation operation for the current seat and finish the decision.",
    promptSnippet: "Submit one valid Catan negotiation operation and finish the decision",
    promptGuidelines: [
      "Call choose_negotiation exactly once during a negotiation request.",
      "Use exact offer and promise IDs from the current request.",
      "For every make-offer operation, set targetPlayerId to another player, including when scope is public.",
      "For direct records, set scope to direct and scopePlayerId to the recipient.",
    ],
    parameters: NegotiationToolParameters,
    execute: async (_toolCallId, parameters) =>
      clearQueueOnTermination(
        negotiationGate.choose(negotiationActionFromToolInput(parameters), parameters.reason),
      ),
  });
  const inspectGame = defineTool({
    name: "inspect_game",
    label: "Inspect game",
    description:
      "Read one seat-visible part of the current Catan request without ending the decision.",
    promptSnippet: "Inspect one seat-visible part of the current Catan request",
    promptGuidelines: [
      "Use inspect_game only while planning and only when the requested section helps the decision.",
      "Inspection does not select an action or negotiation operation.",
    ],
    parameters: Type.Object({ section: StringEnum(INSPECTION_SECTIONS) }),
    execute: async (_toolCallId, parameters) =>
      clearQueueOnTermination(inspectionGate.inspect(parameters.section)),
  });
  const cwd = process.cwd();
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    thinkingLevel: thinkingLevel ?? "high",
    resourceLoader: emptyResourceLoader(systemPromptFor(player)),
    tools: ["inspect_game", "choose_action", "choose_negotiation"],
    customTools: [inspectGame, chooseAction, chooseNegotiation],
    sessionManager: sessionManagerFor(cwd, sessionDirectory, resumedSessionFile),
    settingsManager: SettingsManager.inMemory({
      compaction: compactionSettingsForContext(model.contextWindow),
      retry: { enabled: false },
    }),
  });
  sdkSession = session;
  const channel = new SdkDecisionChannel(
    session,
    actionGate,
    negotiationGate,
    inspectionGate,
    turnBudget,
  );
  return session.sessionFile === undefined
    ? channel
    : Object.assign(channel, {
        session: { sessionId: session.sessionId, sessionFile: session.sessionFile },
      });
};

const harborKindsAtVertex = (
  vertexId: string,
  observation: AgentDecisionRequest["observation"],
): ReadonlyArray<string> => {
  const vertex = observation.topology.vertices.find(({ id }) => id === vertexId);
  if (vertex === undefined) {
    return [];
  }
  const edgeIds = new Set(vertex.edgeIds);
  return observation.layout.harbors
    .filter(({ edgeId }) => edgeIds.has(edgeId))
    .map(({ kind }) => kind);
};

const describeVertexAction = (
  action: LegalAction,
  vertexId: string,
  observation: AgentDecisionRequest["observation"],
): Readonly<Record<string, unknown>> => {
  const vertex = observation.topology.vertices.find(({ id }) => id === vertexId);
  const terrain = new Map(observation.layout.terrain.map((item) => [item.hexId, item.terrain]));
  const numbers = new Map(observation.layout.numbers.map((item) => [item.hexId, item.number]));
  return {
    actionId: action.id,
    type: action.command.command.type,
    vertexId,
    adjacentHexes: (vertex?.adjacentHexIds ?? []).map((hexId) => ({
      hexId,
      terrain: terrain.get(hexId),
      number: numbers.get(hexId) ?? null,
    })),
    harbors: harborKindsAtVertex(vertexId, observation),
  };
};

const describeAction = (
  action: LegalAction,
  observation: AgentDecisionRequest["observation"],
): Readonly<Record<string, unknown>> => {
  const command = action.command.command;
  if ("edgeId" in command) {
    const edge = observation.topology.edges.find(({ id }) => id === command.edgeId);
    return {
      actionId: action.id,
      ...command,
      endpoints: edge === undefined ? [] : edge.vertexIds,
    };
  }
  if ("vertexId" in command) {
    return describeVertexAction(action, command.vertexId, observation);
  }
  return { actionId: action.id, ...command };
};

const inspectionSections = (
  request: AgentDecisionRequest | AgentNegotiationRequest,
): InspectionSections => ({
  status: {
    matchId: request.matchId,
    sequence: "sequence" in request ? request.sequence : request.gameSequence,
    playerId: request.playerId,
    turnKey: request.turnKey,
    phase: request.observation.phase,
    activePlayerId: request.observation.activePlayerId,
    result: request.observation.result,
    ...("round" in request ? { round: request.round, turnPlayerId: request.turnPlayerId } : {}),
  },
  board: {
    topology: request.observation.topology,
    layout: request.observation.layout,
    occupancy: request.observation.occupancy,
  },
  players: {
    players: request.observation.players,
    awards: request.observation.awards,
    result: request.observation.result,
  },
  inventory: {
    ownVictoryPoints: request.observation.ownVictoryPoints,
    ownResources: request.observation.ownResources,
    ownDevelopmentCards: request.observation.ownDevelopmentCards,
  },
  ...("legalActions" in request
    ? {
        "legal-actions": request.legalActions.map((action) =>
          describeAction(action, request.observation),
        ),
      }
    : { negotiation: negotiationForPrompt(request) }),
});

const gameFinalizationPrompt = (legalActionIds: ReadonlyArray<string>, timedOut: boolean): string =>
  `${timedOut ? "The exploration time expired." : "Exploration ended without a selection."} Inspection is now disabled. Call choose_action immediately with exactly one of these action IDs and no more analysis: ${legalActionIds.join(", ")}`;

const negotiationFinalizationPrompt = (timedOut: boolean): string =>
  `${timedOut ? "The exploration time expired." : "Exploration ended without a selection."} Inspection is now disabled. Call choose_negotiation immediately with one valid operation and no more analysis.`;

export const buildDecisionPrompt = (request: AgentDecisionRequest): string =>
  JSON.stringify(
    {
      task: "Choose one legal Catan action and call choose_action.",
      selectionRule:
        "Copy actionId exactly from this request's legalActions list; never infer an actionId from the board.",
      matchId: request.matchId,
      sequence: request.sequence,
      playerId: request.playerId,
      phase: request.observation.phase,
      activePlayerId: request.observation.activePlayerId,
      players: request.observation.players,
      awards: request.observation.awards,
      result: request.observation.result,
      ownVictoryPoints: request.observation.ownVictoryPoints,
      ownResources: request.observation.ownResources,
      ownDevelopmentCards: request.observation.ownDevelopmentCards,
      occupiedBuildings: request.observation.occupancy.buildings,
      occupiedRoads: request.observation.occupancy.roads,
      legalActions: request.legalActions.map((action) =>
        describeAction(action, request.observation),
      ),
    },
    undefined,
    2,
  );

const MAX_NEGOTIATION_PROMPT_EVENTS = 128;
const MAX_NEGOTIATION_PROMPT_PROMISES = 32;
const MAX_NEGOTIATION_PROMPT_EVIDENCE = 64;
const MAX_NEGOTIATION_PROMPT_BYTES = 24_576;
const utf8Encoder = new TextEncoder();

type PromptNegotiation = AgentNegotiationRequest["negotiation"];

const reindexNegotiationEvents = (
  events: PromptNegotiation["events"],
): PromptNegotiation["events"] => events.map((event, sequence) => ({ ...event, sequence }));

const initialNegotiationForPrompt = (negotiation: PromptNegotiation): PromptNegotiation => {
  const promises = negotiation.promises.slice(-MAX_NEGOTIATION_PROMPT_PROMISES);
  const promiseIds = new Set(promises.map(({ id }) => id));
  const events = reindexNegotiationEvents(negotiation.events.slice(-MAX_NEGOTIATION_PROMPT_EVENTS));
  return {
    ...negotiation,
    sequence: events.length,
    events,
    promises,
    evidence: negotiation.evidence
      .filter(({ promiseId }) => promiseIds.has(promiseId))
      .slice(-MAX_NEGOTIATION_PROMPT_EVIDENCE),
  };
};

const trimNegotiationPromptHistory = (
  negotiation: PromptNegotiation,
): PromptNegotiation | undefined => {
  if (negotiation.events.length > 0) {
    const events = reindexNegotiationEvents(negotiation.events.slice(1));
    return { ...negotiation, sequence: events.length, events };
  }
  if (negotiation.evidence.length > 0) {
    return { ...negotiation, evidence: negotiation.evidence.slice(1) };
  }
  if (negotiation.promises.length > 0) {
    const promises = negotiation.promises.slice(1);
    const promiseIds = new Set(promises.map(({ id }) => id));
    return {
      ...negotiation,
      promises,
      evidence: negotiation.evidence.filter(({ promiseId }) => promiseIds.has(promiseId)),
    };
  }
  if (negotiation.offers.length > 0) {
    return { ...negotiation, offers: negotiation.offers.slice(1) };
  }
  return undefined;
};

const negotiationPromptPayload = (
  request: AgentNegotiationRequest,
  negotiation: PromptNegotiation,
): Readonly<Record<string, unknown>> => ({
  task: "Choose one negotiation operation and call choose_negotiation.",
  fallback:
    "If tool calls are unavailable, return only one JSON object that matches NegotiationAction.",
  matchId: request.matchId,
  gameSequence: request.gameSequence,
  playerId: request.playerId,
  turnPlayerId: request.turnPlayerId,
  round: request.round,
  phase: request.observation.phase,
  players: request.observation.players,
  awards: request.observation.awards,
  ownVictoryPoints: request.observation.ownVictoryPoints,
  ownResources: request.observation.ownResources,
  ownDevelopmentCards: request.observation.ownDevelopmentCards,
  occupiedBuildings: request.observation.occupancy.buildings,
  occupiedRoads: request.observation.occupancy.roads,
  negotiation,
  rules: [
    "Passing is always allowed.",
    "Only the active turn player can make a new offer.",
    "Every make-offer operation requires targetPlayerId, including a public offer.",
    "Only an open offer target can counter, accept, or reject it.",
    "Only an open offer proposer can withdraw it.",
    "Offers must exchange at least one resource each way and cannot exchange the same resource type both ways.",
    "Messages and promises can be public or directed. Promises are nonbinding.",
  ],
});

const negotiationForPrompt = (request: AgentNegotiationRequest): PromptNegotiation => {
  let negotiation = initialNegotiationForPrompt(request.negotiation);
  for (;;) {
    const prompt = JSON.stringify(negotiationPromptPayload(request, negotiation), undefined, 2);
    if (utf8Encoder.encode(prompt).byteLength <= MAX_NEGOTIATION_PROMPT_BYTES) return negotiation;
    const trimmed = trimNegotiationPromptHistory(negotiation);
    if (trimmed === undefined) {
      throw new AgentDecisionError({ message: "The negotiation prompt exceeds its byte limit." });
    }
    negotiation = trimmed;
  }
};

export const buildNegotiationPrompt = (request: AgentNegotiationRequest): string =>
  JSON.stringify(negotiationPromptPayload(request, negotiationForPrompt(request)), undefined, 2);

export interface PiCostBudgetSnapshot {
  readonly ceilingUsd: number;
  readonly nextRequestExposureUsd: number;
  readonly observedUsd: number;
}

const assertPositiveFinite = (value: number, message: string): void => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(message);
};

export class PiCostBudget {
  readonly #ceilingUsd: number;
  readonly #nextRequestExposureUsd: number;
  #observedUsd = 0;

  constructor(ceilingUsd: number, nextRequestExposureUsd: number, observedUsd = 0) {
    assertPositiveFinite(ceilingUsd, "The cost ceiling must be a positive finite number.");
    assertPositiveFinite(
      nextRequestExposureUsd,
      "The next-request cost exposure must be a positive finite number.",
    );
    if (!Number.isFinite(observedUsd) || observedUsd < 0) {
      throw new Error("The observed cost must be a non-negative finite number.");
    }
    if (nextRequestExposureUsd > ceilingUsd) {
      throw new Error("The next-request cost exposure exceeds the cost ceiling.");
    }
    if (observedUsd + nextRequestExposureUsd > ceilingUsd) {
      throw new Error("The observed cost and the next-request exposure exceed the cost ceiling.");
    }
    this.#ceilingUsd = ceilingUsd;
    this.#nextRequestExposureUsd = nextRequestExposureUsd;
    this.#observedUsd = observedUsd;
  }

  snapshot(): PiCostBudgetSnapshot {
    return {
      ceilingUsd: this.#ceilingUsd,
      nextRequestExposureUsd: this.#nextRequestExposureUsd,
      observedUsd: this.#observedUsd,
    };
  }

  async run<T extends { readonly usage?: AgentUsage }>(operation: () => Promise<T>): Promise<T> {
    if (this.#observedUsd + this.#nextRequestExposureUsd > this.#ceilingUsd) {
      throw new AgentRunAbort({ message: "The Pi run cost ceiling cannot admit another request." });
    }
    try {
      const result = await operation();
      this.#addUsage(result.usage);
      return result;
    } catch (error) {
      if (error instanceof AgentDecisionError) this.#addUsage(error.usage);
      throw error;
    }
  }

  #addUsage(usage: AgentUsage | undefined): void {
    if (usage === undefined) return;
    if (!Number.isFinite(usage.cost) || usage.cost < 0) {
      throw new AgentRunAbort({ message: "The provider returned invalid cost usage." });
    }
    this.#observedUsd += usage.cost;
  }
}

export const withPiCostBudget =
  (createAgent: SeatAgentFactory, budget: PiCostBudget): SeatAgentFactory =>
  async (player) => {
    const agent = await createAgent(player);
    const negotiate = agent.negotiate?.bind(agent);
    return {
      ...(agent.model === undefined ? {} : { model: agent.model }),
      async decide(request) {
        return budget.run(async () => agent.decide(request));
      },
      ...(negotiate === undefined
        ? {}
        : {
            async negotiate(request: AgentNegotiationRequest) {
              return budget.run(async () => negotiate.call(agent, request));
            },
          }),
      async cancel() {
        await agent.cancel();
      },
      async dispose() {
        await agent.dispose();
      },
    };
  };

export const createPiSeatAgent = (
  model: PiModelReference,
  channel: PiDecisionChannel,
): SeatAgent => ({
  model,
  async decide(request) {
    return channel.run(request);
  },
  async negotiate(request) {
    return channel.negotiate(request);
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

const validateModelLimits = (
  maxOutputTokens: number | undefined,
  contextWindowTokens: number,
): void => {
  if (
    maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
  ) {
    throw new Error("maxOutputTokens must be a positive integer.");
  }
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 32_768) {
    throw new Error("contextWindowTokens must be an integer of at least 32768.");
  }
};

const boundedModel = (options: PiAgentFactoryOptions, model: PiModel): PiModel => {
  const contextWindowTokens = options.contextWindowTokens ?? model.contextWindow;
  validateModelLimits(options.maxOutputTokens, contextWindowTokens);
  const contextWindow = Math.min(model.contextWindow, contextWindowTokens);
  const requestedMaxTokens = options.maxOutputTokens ?? contextWindow - 1;
  const maxTokens = Math.min(model.maxTokens, requestedMaxTokens);
  if (maxTokens >= contextWindow) {
    throw new Error("maxOutputTokens must be smaller than the effective context window.");
  }
  return { ...model, contextWindow, maxTokens };
};

const modelForSeat = (
  options: PiAgentFactoryOptions,
  seatIndex: number,
): { readonly reference: PiModelReference; readonly model: PiModel } => {
  const reference = options.models[seatIndex % options.models.length];
  if (reference === undefined) throw new Error("No Pi model is assigned to the seat.");
  const model = options.modelRuntime.getModel(reference.provider, reference.modelId);
  if (model === undefined) {
    throw new Error(`Unknown Pi model: ${reference.provider}/${reference.modelId}`);
  }
  return { reference, model: boundedModel(options, model) };
};

const DEFAULT_TURN_TIME_MS = 600_000;
/** The finalization grace of one decision. A live model run needs minutes. */
const DEFAULT_FINALIZATION_GRACE_MS = 300_000;
const DEFAULT_MAX_PLANNING_STEPS = 8;

const boundedPositiveInteger = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const bounded = value ?? fallback;
  if (!Number.isSafeInteger(bounded) || bounded < 1 || bounded > 0x7fff_ffff) {
    throw new Error(`${name} must be a positive integer no larger than 2147483647.`);
  }
  return bounded;
};

const createChannelForSeat = async (
  options: PiAgentFactoryOptions,
  player: PlayerConfig,
  model: PiModel,
): Promise<PiDecisionChannel> => {
  const resumedSessionFile = options.resumedSessions?.get(player.id);
  return (options.createChannel ?? createSdkDecisionChannel)({
    player,
    model,
    modelRuntime: options.modelRuntime,
    thinkingLevel: options.thinkingLevel,
    turnTimeMs: boundedPositiveInteger(options.turnTimeMs, DEFAULT_TURN_TIME_MS, "turnTimeMs"),
    finalizationGraceMs: boundedPositiveInteger(
      options.finalizationGraceMs,
      DEFAULT_FINALIZATION_GRACE_MS,
      "finalizationGraceMs",
    ),
    maxPlanningSteps: boundedPositiveInteger(
      options.maxPlanningSteps,
      DEFAULT_MAX_PLANNING_STEPS,
      "maxPlanningSteps",
    ),
    ...(options.sessionDirectory === undefined
      ? {}
      : { sessionDirectory: options.sessionDirectory }),
    ...(resumedSessionFile === undefined ? {} : { resumedSessionFile }),
  });
};

const registerChannelSession = async (
  options: PiAgentFactoryOptions,
  player: PlayerConfig,
  channel: PiDecisionChannel,
): Promise<void> => {
  if (options.sessionDirectory !== undefined && channel.session === undefined) {
    await channel.dispose();
    throw new Error(`The Pi channel for ${player.id} did not create a persistent session.`);
  }
  if (channel.session === undefined || options.onSessionCreated === undefined) return;
  try {
    await options.onSessionCreated(player, channel.session);
  } catch (error) {
    await channel.dispose();
    throw error;
  }
};

export const createPiAgentFactory = (options: PiAgentFactoryOptions): SeatAgentFactory => {
  if (options.models.length === 0) throw new Error("At least one Pi model is required.");
  boundedPositiveInteger(options.turnTimeMs, DEFAULT_TURN_TIME_MS, "turnTimeMs");
  boundedPositiveInteger(
    options.finalizationGraceMs,
    DEFAULT_FINALIZATION_GRACE_MS,
    "finalizationGraceMs",
  );
  boundedPositiveInteger(options.maxPlanningSteps, DEFAULT_MAX_PLANNING_STEPS, "maxPlanningSteps");
  let seatIndex = 0;
  return async (player) => {
    const { reference, model } = modelForSeat(options, seatIndex);
    seatIndex += 1;
    const channel = await createChannelForSeat(options, player, model);
    await registerChannelSession(options, player, channel);
    return createPiSeatAgent(reference, channel);
  };
};

export const pinOpenRouterProvider = (
  runtime: ModelRuntime,
  references: ReadonlyArray<PiModelReference>,
  providerSlug: string,
): void => {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(providerSlug)) {
    throw new Error("The OpenRouter provider must be a lowercase provider slug.");
  }
  const modelIds = [
    ...new Set(
      references.filter(({ provider }) => provider === "openrouter").map(({ modelId }) => modelId),
    ),
  ];
  if (modelIds.length === 0) {
    throw new Error("An OpenRouter provider route requires at least one OpenRouter model.");
  }
  const routedModels = modelIds.map((modelId) => {
    const model = runtime.getModel("openrouter", modelId);
    if (model === undefined) throw new Error(`Unknown Pi model: openrouter/${modelId}`);
    return {
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
      input: [...model.input],
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(model.samplingParams === undefined ? {} : { samplingParams: model.samplingParams }),
      ...(model.headers === undefined ? {} : { headers: model.headers }),
      compat: {
        ...model.compat,
        openRouterRouting: {
          allow_fallbacks: false,
          only: [providerSlug],
        },
      },
    };
  });
  runtime.registerProvider("openrouter", { models: routedModels });
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

/**
 * The thinking-levels config. One run names one file. The file states, for each provider and
 * model, which provider value each harness thinking level sends, and it holds the deliberate
 * run pins that hold a model at a level on purpose. The file is version-controlled, so a level
 * map is reviewable, reproducible, and independent of a hand edit in a model cache.
 */
export const THINKING_LEVELS_SCHEMA = "catanarchy.thinking-levels.v1";

/** The provider value of each harness level, or `null` when the model cannot express it. */
export type ThinkingLevelMap = Readonly<Partial<Record<PiThinkingLevel, string | null>>>;

/** One provider block: one level map for each model it names. */
export interface ThinkingLevelsProvider {
  readonly provider: string;
  readonly api: string;
  readonly parameter: string;
  /** How the map was measured. Prose for the reader, not a rule. */
  readonly evidence?: string;
  readonly levelMap: ThinkingLevelMap;
  readonly models: readonly string[];
}

/** One deliberate run pin, such as holding a model at a lower level while another is raised. */
export interface ThinkingLevelsPin {
  readonly provider: string;
  readonly modelId: string;
  readonly reason: string;
  readonly levelMap: Readonly<Partial<Record<PiThinkingLevel, string>>>;
}

export interface ThinkingLevelsConfig {
  readonly schema: string;
  readonly probedAt: string;
  readonly providers: readonly ThinkingLevelsProvider[];
  readonly runPins: readonly ThinkingLevelsPin[];
}

/** What a config changed. The run record carries this list. */
export interface ThinkingLevelsApplication {
  readonly kind: "provider" | "pin";
  readonly provider: string;
  readonly modelId: string;
  readonly levelMap: ThinkingLevelMap;
  readonly reason?: string;
}

/** What one seat model sends for the level the run asked for. */
export interface ThinkingLevelResolution {
  readonly provider: string;
  readonly modelId: string;
  readonly requestedLevel: PiThinkingLevel;
  readonly providerValue: string;
  readonly source: "config" | "pin" | "catalog";
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
};

const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array.`);
  }
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
};

const knownLevel = (key: string, field: string): PiThinkingLevel => {
  if (!(PI_THINKING_LEVELS as readonly string[]).includes(key)) {
    throw new Error(
      `${field} names an unknown thinking level "${key}". Known levels: ${PI_THINKING_LEVELS.join(", ")}.`,
    );
  }
  return key as PiThinkingLevel;
};

const assertKnownLevels = (value: Record<string, unknown>, field: string): void => {
  for (const key of Object.keys(value)) knownLevel(key, field);
};

const fullLevelMap = (value: unknown, field: string): ThinkingLevelMap => {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object.`);
  assertKnownLevels(value, field);
  const result = {} as Record<PiThinkingLevel, string | null>;
  for (const level of PI_THINKING_LEVELS) {
    if (!(level in value))
      throw new Error(`${field} must name every thinking level. Missing: ${level}.`);
    const mapped = value[level];
    result[level] = mapped === null ? null : nonEmptyString(mapped, `${field}.${level}`);
  }
  return result;
};

const partialLevelMap = (
  value: unknown,
  field: string,
): Partial<Record<PiThinkingLevel, string>> => {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object.`);
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error(`${field} must name at least one thinking level.`);
  const result: Partial<Record<PiThinkingLevel, string>> = {};
  for (const [key, mapped] of entries) {
    result[knownLevel(key, field)] = nonEmptyString(mapped, `${field}.${key}`);
  }
  return result;
};

const requireArray = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value;
};

const requireProbedAt = (value: unknown, source: string): string => {
  const probedAt = nonEmptyString(value, `${source}: probedAt`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(probedAt)) {
    throw new Error(`${source}: probedAt must use the YYYY-MM-DD form.`);
  }
  return probedAt;
};

const parseJsonObject = (text: string, source: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${source} is not valid JSON: ${reason}`);
  }
  if (!isPlainObject(value)) throw new Error(`${source} must hold a JSON object.`);
  return value;
};

const parseProvider = (raw: unknown, source: string, index: number): ThinkingLevelsProvider => {
  const field = `${source}: providers[${index}]`;
  if (!isPlainObject(raw)) throw new Error(`${field} must be an object.`);
  const rawEvidence = raw["evidence"];
  const evidence =
    rawEvidence === undefined ? undefined : nonEmptyString(rawEvidence, `${field}.evidence`);
  return {
    provider: nonEmptyString(raw["provider"], `${field}.provider`),
    api: nonEmptyString(raw["api"], `${field}.api`),
    parameter: nonEmptyString(raw["parameter"], `${field}.parameter`),
    ...(evidence === undefined ? {} : { evidence }),
    levelMap: fullLevelMap(raw["levelMap"], `${field}.levelMap`),
    models: stringArray(raw["models"], `${field}.models`),
  };
};

const parsePin = (raw: unknown, source: string, index: number): ThinkingLevelsPin => {
  const field = `${source}: runPins[${index}]`;
  if (!isPlainObject(raw)) throw new Error(`${field} must be an object.`);
  return {
    provider: nonEmptyString(raw["provider"], `${field}.provider`),
    modelId: nonEmptyString(raw["modelId"], `${field}.modelId`),
    reason: nonEmptyString(raw["reason"], `${field}.reason`),
    levelMap: partialLevelMap(raw["levelMap"], `${field}.levelMap`),
  };
};

/** Parse and validate a thinking-levels config. A bad file fails before any model call. */
export const parseThinkingLevelsConfig = (text: string, source: string): ThinkingLevelsConfig => {
  const value = parseJsonObject(text, source);
  if (value["schema"] !== THINKING_LEVELS_SCHEMA) {
    throw new Error(`${source} must declare schema "${THINKING_LEVELS_SCHEMA}".`);
  }
  const providers = requireArray(value["providers"], `${source}: providers`);
  if (providers.length === 0) throw new Error(`${source}: providers must be a non-empty array.`);
  const rawPins = value["runPins"];
  const pins = rawPins === undefined ? [] : requireArray(rawPins, `${source}: runPins`);
  return {
    schema: THINKING_LEVELS_SCHEMA,
    probedAt: requireProbedAt(value["probedAt"], source),
    providers: providers.map((raw, index) => parseProvider(raw, source, index)),
    runPins: pins.map((raw, index) => parsePin(raw, source, index)),
  };
};

export const loadThinkingLevelsConfig = async (path: string): Promise<ThinkingLevelsConfig> =>
  parseThinkingLevelsConfig(await readFile(path, "utf8"), path);

const providerModelEntry = (model: PiModel, thinkingLevelMap: ThinkingLevelMap) => ({
  id: model.id,
  name: model.name,
  api: model.api,
  ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
  reasoning: model.reasoning,
  thinkingLevelMap,
  input: [...model.input],
  cost: model.cost,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  ...(model.samplingParams === undefined ? {} : { samplingParams: model.samplingParams }),
  ...(model.headers === undefined ? {} : { headers: model.headers }),
  ...(model.compat === undefined ? {} : { compat: model.compat }),
});

interface ProviderPlan {
  readonly levelMaps: Map<string, ThinkingLevelMap>;
  readonly kinds: Map<string, "provider" | "pin">;
  readonly reasons: Map<string, string>;
}

const planProvider = (
  runtime: ModelRuntime,
  providerId: string,
  config: ThinkingLevelsConfig,
  known: ReadonlySet<string>,
): ProviderPlan => {
  const levelMaps = new Map<string, ThinkingLevelMap>();
  const kinds = new Map<string, "provider" | "pin">();
  const reasons = new Map<string, string>();
  const baseLevelMap = (modelId: string): ThinkingLevelMap =>
    levelMaps.get(modelId) ?? runtime.getModel(providerId, modelId)?.thinkingLevelMap ?? {};
  const requireKnown = (modelId: string): void => {
    if (!known.has(modelId)) throw new Error(`Unknown Pi model: ${providerId}/${modelId}`);
  };
  for (const block of config.providers) {
    if (block.provider !== providerId) continue;
    for (const modelId of block.models) {
      requireKnown(modelId);
      levelMaps.set(modelId, { ...baseLevelMap(modelId), ...block.levelMap });
      kinds.set(modelId, "provider");
    }
  }
  for (const pin of config.runPins) {
    if (pin.provider !== providerId) continue;
    requireKnown(pin.modelId);
    levelMaps.set(pin.modelId, { ...baseLevelMap(pin.modelId), ...pin.levelMap });
    kinds.set(pin.modelId, "pin");
    reasons.set(pin.modelId, pin.reason);
  }
  return { levelMaps, kinds, reasons };
};

const applicationOf = (
  plan: ProviderPlan,
  providerId: string,
  modelId: string,
  levelMap: ThinkingLevelMap,
): ThinkingLevelsApplication => {
  const reason = plan.reasons.get(modelId);
  return {
    kind: plan.kinds.get(modelId) ?? "provider",
    provider: providerId,
    modelId,
    levelMap,
    ...(reason === undefined ? {} : { reason }),
  };
};

const providerIdsOf = (config: ThinkingLevelsConfig): string[] => [
  ...new Set([
    ...config.providers.map(({ provider }) => provider),
    ...config.runPins.map(({ provider }) => provider),
  ]),
];

/**
 * Apply a thinking-levels config to a runtime. Each named provider is registered again with the
 * level map of the config, and every other model of that provider keeps its own entry. The
 * function returns what it changed, so the run record can state the map in effect.
 */
export const applyThinkingLevels = (
  runtime: ModelRuntime,
  config: ThinkingLevelsConfig,
): ThinkingLevelsApplication[] => {
  const applications: ThinkingLevelsApplication[] = [];
  for (const providerId of providerIdsOf(config)) {
    const available = runtime.getModels(providerId);
    if (available.length === 0) throw new Error(`Unknown Pi provider: ${providerId}`);
    const plan = planProvider(runtime, providerId, config, new Set(available.map(({ id }) => id)));
    runtime.registerProvider(providerId, {
      models: available.map((model) =>
        providerModelEntry(model, plan.levelMaps.get(model.id) ?? model.thinkingLevelMap ?? {}),
      ),
    });
    for (const [modelId, levelMap] of plan.levelMaps) {
      applications.push(applicationOf(plan, providerId, modelId, levelMap));
    }
  }
  return applications;
};

const requireSupportedLevel = (model: PiModel, key: string, level: PiThinkingLevel): void => {
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(level)) return;
  throw new Error(
    `${key} cannot express thinking level ${level}. Supported levels: ${supported.join(", ")}. ` +
      "Name the level for the model in the thinking-levels config, or pass a supported level.",
  );
};

const resolutionSource = (
  applications: ReadonlyArray<ThinkingLevelsApplication>,
  provider: string,
  modelId: string,
): "config" | "pin" | "catalog" => {
  const application = applications.find(
    (entry) => entry.provider === provider && entry.modelId === modelId,
  );
  if (application === undefined) return "catalog";
  return application.kind === "pin" ? "pin" : "config";
};

/**
 * The provider value every seat model sends for one level. A model that cannot express the level
 * stops the run, so a level never changes without a record and a silent clamp never happens.
 */
export const resolveThinkingLevels = (
  runtime: ModelRuntime,
  references: ReadonlyArray<PiModelReference>,
  level: PiThinkingLevel,
  applications: ReadonlyArray<ThinkingLevelsApplication> = [],
): ThinkingLevelResolution[] => {
  const resolutions: ThinkingLevelResolution[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.provider}/${reference.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const model = runtime.getModel(reference.provider, reference.modelId);
    if (model === undefined) throw new Error(`Unknown Pi model: ${key}`);
    requireSupportedLevel(model, key, level);
    resolutions.push({
      provider: reference.provider,
      modelId: reference.modelId,
      requestedLevel: level,
      providerValue: model.thinkingLevelMap?.[level] ?? level,
      source: resolutionSource(applications, reference.provider, reference.modelId),
    });
  }
  return resolutions;
};

export { ModelRuntime };
