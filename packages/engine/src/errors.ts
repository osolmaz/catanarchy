import { Data } from "effect";

export type RuleViolationCode =
  | "duplicate-player-color"
  | "invalid-config"
  | "invalid-command"
  | "duplicate-player-id"
  | "invalid-player-count"
  | "invalid-seed"
  | "occupied-edge"
  | "occupied-vertex"
  | "road-not-adjacent"
  | "settlement-too-close"
  | "stale-command"
  | "unknown-location"
  | "wrong-command"
  | "wrong-player";

export class RuleViolation extends Data.TaggedError("RuleViolation")<{
  readonly code: RuleViolationCode;
  readonly message: string;
}> {}

export class ReplayViolation extends Data.TaggedError("ReplayViolation")<{
  readonly message: string;
}> {}
