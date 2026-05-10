import { COLORS } from './types';
import type { GameState, Noble, PlayerIndex, PlayerState } from './types';
import { isTerminal, winner } from './apply';

export const TERMINAL_WIN = 1000;
export const TERMINAL_LOSS = -1000;

export type Feature = (state: GameState, player: PlayerIndex) => number;
export type WeightedFeature = { name: string; weight: number; fn: Feature };

// === Feature 1: prestige ===
// The literal score. One-for-one.
export const prestigeFeature: Feature = (state, player) =>
  state.players[player]?.prestige ?? 0;

// === Feature 2: bonus count ===
// Each permanent bonus card is a discount on every future card matching that
// color. Sub-prestige weighting because the literal score is prestige.
export const bonusCountFeature: Feature = (state, player) => {
  const p = state.players[player];
  if (p === undefined) return 0;
  let total = 0;
  for (const c of COLORS) total += p.bonuses[c];
  return total;
};

// === Feature 3: noble proximity ===
// For each unclaimed noble, score how close `player` is to claiming it on a
// scale of 0 (no progress) to 3 (one bonus away). Linear in proximity ratio
// so a half-completed noble contributes 1.5 expected prestige.
const nobleProximityForOne = (player: PlayerState, noble: Noble): number => {
  let need = 0;
  let maxNeed = 0;
  for (const c of COLORS) {
    const r = noble.requirement[c];
    maxNeed += r;
    need += Math.max(0, r - player.bonuses[c]);
  }
  if (maxNeed === 0) return 0;
  const proximity = maxNeed - need;
  return 3 * (proximity / maxNeed);
};

export const nobleProximityFeature: Feature = (state, player) => {
  const p = state.players[player];
  if (p === undefined) return 0;
  let total = 0;
  for (const noble of state.nobles) {
    total += nobleProximityForOne(p, noble);
  }
  return total;
};

/**
 * Combine feature scores into a single number. Pure: every evaluator the
 * engine ever uses can be expressed as a `WeightedFeature[]`.
 */
export const evaluateWith = (
  features: readonly WeightedFeature[],
  state: GameState,
  player: PlayerIndex,
): number => {
  if (isTerminal(state)) {
    return winner(state) === player ? TERMINAL_WIN : TERMINAL_LOSS;
  }
  let score = 0;
  for (const f of features) score += f.weight * f.fn(state, player);
  return score;
};

// === Phase 1 v1 ===
// Baseline evaluator. Kept exported so we can A/B test future versions
// against it in tournament.test.ts and the play CLI.
export const FEATURES_BASELINE: readonly WeightedFeature[] = [
  { name: 'prestige', weight: 1.0, fn: prestigeFeature },
  { name: 'bonus_count', weight: 0.5, fn: bonusCountFeature },
];

export const evaluateBaseline: Feature = (state, player) =>
  evaluateWith(FEATURES_BASELINE, state, player);

// === Phase 1 v2 ===
// Add noble proximity. Hypothesis: greedy currently has no signal for nobles
// until they're literally claimed (and the +3 prestige hits). With this
// feature it should aim partial bonus columns at noble requirements multiple
// turns earlier.
export const FEATURES_V2: readonly WeightedFeature[] = [
  ...FEATURES_BASELINE,
  { name: 'noble_proximity', weight: 1.0, fn: nobleProximityFeature },
];

export const evaluateV2: Feature = (state, player) =>
  evaluateWith(FEATURES_V2, state, player);

// === Candidate feature: concentration (top-2 bonuses) ===
// Tried during Experiment 3 (see diary/phase-01-evaluator.md). Hypothesis was
// that rewarding the two tallest bonus columns would push greedy toward
// 4+4 noble shapes (F4) and toward T3-anchor reachability (F3). It did not.
// At weights 0.5, 0.3, 0.2, head-to-head match against v2 came out -4 to -8
// percentage points. Best guess: v2 already follows the board adaptively; a
// rigid concentration prior makes greedy refuse cheap diversifying cards,
// losing tempo.
//
// Kept exported for reference and so the regression is locked in via tests.
export const concentrationFeature: Feature = (state, player) => {
  const p = state.players[player];
  if (p === undefined) return 0;
  let top1 = 0;
  let top2 = 0;
  for (const c of COLORS) {
    const v = p.bonuses[c];
    if (v > top1) {
      top2 = top1;
      top1 = v;
    } else if (v > top2) {
      top2 = v;
    }
  }
  return top1 + top2;
};

// `evaluate` always points at the current best evaluator. v2 currently leads.
export const evaluate: Feature = evaluateV2;
