import { Data } from "effect";

export type RuleViolationCode =
  | "duplicate-player-color"
  | "invalid-config"
  | "invalid-command"
  | "development-deck-empty"
  | "disconnected-route"
  | "duplicate-player-id"
  | "insufficient-resources"
  | "invalid-player-count"
  | "invalid-seed"
  | "invalid-trade"
  | "occupied-edge"
  | "occupied-vertex"
  | "piece-supply"
  | "road-not-adjacent"
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
