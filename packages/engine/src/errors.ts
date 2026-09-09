import { Data } from "effect";

export type RuleViolationCode =
  | "duplicate-player-color"
  | "invalid-config"
  | "invalid-command"
  | "development-card-unavailable"
  | "development-deck-empty"
  | "disconnected-route"
  | "duplicate-player-id"
  | "insufficient-resources"
  | "invalid-discard"
  | "invalid-player-count"
  | "invalid-seed"
  | "invalid-trade"
  | "invalid-victim"
  | "occupied-edge"
  | "occupied-vertex"
  | "piece-supply"
  | "road-not-adjacent"
  | "robber-must-move"
  | "settlement-too-close"
  | "stale-command"
  | "unknown-location"
  | "wrong-command"
  | "wrong-match"
  | "wrong-player";

export class RuleViolation extends Data.TaggedError("RuleViolation")<{
  readonly code: RuleViolationCode;
  readonly message: string;
}> {}

export class ReplayViolation extends Data.TaggedError("ReplayViolation")<{
  readonly message: string;
}> {}
