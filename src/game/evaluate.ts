import { COLORS, TIERS } from './types';
import type { Color, GameState, Noble, PlayerIndex, PlayerState } from './types';
import { isTerminal, winner } from './apply';
import { computePayment, totalGems } from './gems';

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

// === Feature 5: demand-weighted engine value ===
// Replaces the flat `bonus_count` with a per-color weighting derived from
// what's actually still in play. For each color c:
//
//   weight[c] = (remaining_demand[c] / total_demand) * 5
//
// where remaining_demand counts every gem of color c demanded by cards still
// face-up or in their respective decks. Average weight is 1 by construction,
// so when demand is uniform the feature degenerates to flat bonus_count.
//
// Intuition: a white bonus is more valuable when 200 gems-worth of white-
// costing cards remain to be bought than when only 50 do. The weight is also
// time-decaying for free: as cards get bought, total demand drops; bonuses
// of any color contribute less; the prestige term naturally takes over in
// the late game.
const remainingColorDemand = (state: GameState): Record<Color, number> => {
  const out: Record<Color, number> = {
    white: 0, blue: 0, green: 0, red: 0, black: 0,
  };
  for (const tier of TIERS) {
    for (const slot of state.faceUp[tier]) {
      if (!slot) continue;
      for (const c of COLORS) out[c] += slot.cost[c];
    }
    for (const card of state.decks[tier]) {
      for (const c of COLORS) out[c] += card.cost[c];
    }
  }
  return out;
};

export const engineValueFeature: Feature = (state, player) => {
  const p = state.players[player];
  if (p === undefined) return 0;
  const demand = remainingColorDemand(state);
  let total = 0;
  for (const c of COLORS) total += demand[c];
  if (total === 0) return 0; // no cards left to buy; bonuses worthless going forward
  let score = 0;
  for (const c of COLORS) {
    const weight = (demand[c] / total) * COLORS.length;
    score += p.bonuses[c] * weight;
  }
  return score;
};

// === Feature 6: gem hand-cap pressure ===
// Penalize states where the player is hoarding gems near the 10-cap. At
// 10, a take action is blocked and the next reserve will force a discard;
// even at 8-9 the player has very little flexibility. Encourages spending
// gems on cards rather than stockpiling.
//
//   pressure(total) = -max(0, total - 7)
//
// → 0 at ≤7 gems, then -1 / -2 / -3 at 8 / 9 / 10. Stable (depends only on
// the player's own gem count) so it composes cleanly with greedy lookahead.
export const gemPressureFeature: Feature = (state, player) => {
  const p = state.players[player];
  if (p === undefined) return 0;
  const total = totalGems(p.gems);
  return Math.min(0, 7 - total);
};

// === Feature 7: opponent threat ===
// Sum of prestige across face-up cards each *opponent* could afford right
// now. Negated, since high opponent buying power is bad for `me`. Unlike
// engine_value or gem_pressure, this *changes* with my action: if I buy a
// card opponents could have afforded, the threat drops. This means greedy
// can use it to bias toward "blocking" buys.
export const opponentThreatFeature: Feature = (state, me) => {
  let threat = 0;
  for (let i = 0; i < state.players.length; i++) {
    if (i === me) continue;
    const opp = state.players[i];
    if (opp === undefined) continue;
    for (const tier of TIERS) {
      for (const slot of state.faceUp[tier]) {
        if (slot === null) continue;
        if (computePayment(slot, opp) !== null) {
          threat += slot.prestige;
        }
      }
    }
    for (const r of opp.reserved) {
      if (computePayment(r.card, opp) !== null) {
        threat += r.card.prestige;
      }
    }
  }
  return threat === 0 ? 0 : -threat;
};

// === Phase 1 v3 ===
// v2 + opponent_threat. Hypothesis: action-sensitive (my buys block their
// threats), so unlike static gem_pressure / engine_value it should
// differentiate among my legal actions in a way that helps.
export const FEATURES_V3: readonly WeightedFeature[] = [
  ...FEATURES_V2,
  { name: 'opponent_threat', weight: 0.5, fn: opponentThreatFeature },
];

export const evaluateV3: Feature = (state, player) =>
  evaluateWith(FEATURES_V3, state, player);

// === Feature 8: opponent noble proximity ===
// Mirror of `nobleProximityFeature` but summed across opponents and negated.
// Without this, an opponent who's 4 bonuses deep on a noble is invisible to
// `me` until the noble is actually claimed; with it, the engine treats
// "opponent about to grab +3 prestige for free" as a meaningful threat,
// and prefers buys that beat them to the bonuses that would unlock the
// noble (or claim the noble themselves first).
export const opponentNobleProximityFeature: Feature = (state, me) => {
  let threat = 0;
  for (let i = 0; i < state.players.length; i++) {
    if (i === me) continue;
    const opp = state.players[i];
    if (opp === undefined) continue;
    for (const noble of state.nobles) {
      threat += nobleProximityForOne(opp, noble);
    }
  }
  return threat === 0 ? 0 : -threat;
};

// v3 + opponent_noble_proximity. Weight 0.5 to match opponent_threat: noble
// progress is *future* prestige (not yet claimed), so we don't want it to
// outweigh actual prestige + bonuses on hand.
export const FEATURES_V4: readonly WeightedFeature[] = [
  ...FEATURES_V3,
  { name: 'opponent_noble_proximity', weight: 0.5, fn: opponentNobleProximityFeature },
];

export const evaluateV4: Feature = (state, player) =>
  evaluateWith(FEATURES_V4, state, player);

// `evaluate` always points at the current best evaluator. v3 (with
// opponent_threat) currently leads. Rejected en route under depth-1
// greedy: concentration (Experiment 3), engine_value (Experiment 4),
// gem_pressure (Experiment 5). See diary/phase-01-evaluator.md.
export const evaluate: Feature = evaluateV3;

// === Experimental v3-plus variants used to retest rejected features ===
// Each variant adds one previously-rejected feature back on top of v3 at
// the same weight that lost at depth 1. The Phase 2 retest asks: does
// depth-3 search redeem any of these? Used by `search-d3-conc` etc. in
// the CLI and the Experiment 10 tournament.

export const FEATURES_V3_PLUS_CONC: readonly WeightedFeature[] = [
  ...FEATURES_V3,
  { name: 'concentration_top2', weight: 0.2, fn: concentrationFeature },
];
export const evaluateV3PlusConc: Feature = (state, player) =>
  evaluateWith(FEATURES_V3_PLUS_CONC, state, player);

export const FEATURES_V3_PLUS_ENGINE: readonly WeightedFeature[] = [
  ...FEATURES_V3,
  { name: 'engine_value', weight: 0.2, fn: engineValueFeature },
];
export const evaluateV3PlusEngine: Feature = (state, player) =>
  evaluateWith(FEATURES_V3_PLUS_ENGINE, state, player);

export const FEATURES_V3_PLUS_PRESSURE: readonly WeightedFeature[] = [
  ...FEATURES_V3,
  { name: 'gem_pressure', weight: 0.5, fn: gemPressureFeature },
];
export const evaluateV3PlusPressure: Feature = (state, player) =>
  evaluateWith(FEATURES_V3_PLUS_PRESSURE, state, player);
