import { Data } from "effect";

export type RuleViolationCode =
  | "duplicate-player-color"
  | "duplicate-player-id"
  | "invalid-player-count"
  | "invalid-seed";

export class RuleViolation extends Data.TaggedError("RuleViolation")<{
  readonly code: RuleViolationCode;
  readonly message: string;
}> {}
