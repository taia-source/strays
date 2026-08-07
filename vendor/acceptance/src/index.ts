/**
 * Does the artifact do what was ASKED, not merely what the code says.
 *
 * ══ Why this package exists ══
 *
 * A generated project passed 747 of its own tests, 24 browser checks and two clean Railway
 * deploys, and was the wrong product: no way to enter a token, four invented holder addresses
 * displayed as real, no persistence, no contracts in a product that takes custody.
 *
 * Every one of those checks was sound. All of them measured whether the code does what the
 * code says. None asked whether the artifact was what was requested — and the repo's own
 * `RunSpec` carried six fields (name, chainId, tokens, kind, web, indexer), not one of which
 * can express "a user can enrol a token". The requirement was discarded at extraction, so
 * nothing downstream could miss it.
 *
 * Verification and validation are different things. This is the second one.
 */

export {
  type Capability,
  type Evidence,
  type EvidenceKind,
  IMPLIED_CAPABILITIES,
} from "./capability.js";
export {
  type AcceptanceResult,
  applyJudgements,
  assessAcceptance,
  type CapabilityVerdict,
  checkCapability,
  checkEvidence,
  type EvidenceVerdict,
  formatAcceptance,
  type ProjectView,
  type RenderedPage,
} from "./check.js";
export {
  compileTarget,
  impliedCapabilities,
  isCheckable,
  mergeCapabilities,
} from "./derive.js";
export {
  type DeadEnd,
  firstDeadEnd,
  formatJourney,
  type Journey,
  type JourneyFlaw,
  type JourneyStep,
  type JourneyVerdict,
  validateJourney,
  walkJourney,
} from "./journey.js";
export {
  assessPlaceholders,
  findAdmissions,
  findPlaceholders,
  formatPlaceholders,
  isExemptPath,
  type PlaceholderFinding,
  type PlaceholderVerdict,
} from "./placeholder.js";
export {
  ALWAYS_REQUIRED,
  auditJourney,
  deriveJourney,
  describeGoal,
  pathCoversEveryCapability,
} from "./skeleton.js";
