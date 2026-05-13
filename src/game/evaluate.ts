import { COLORS, TIERS } from './types';
import type { Card, Color, GameState, Noble, PlayerIndex, PlayerState } from './types';
import { isTerminal, winner } from './apply';
import { computePayment, meetsNobleRequirement, totalGems } from './gems';

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

// === V5: endgame race mode ===
// Splendor's late game has a fundamentally different shape than mid-game.
// Once *anyone* hits ~12 prestige the game can end inside a single round,
// which means:
//
//   1. Prestige already on the board matters more than bonuses (no more
//      time to cash bonuses in for prestige).
//   2. Noble proximity matters more for both you and opponents — a 3pp
//      swing inside the last round can win or lose the game.
//   3. Opponent threats are sharper — if they can buy a card right now
//      that puts them over 15, you don't get another turn to react.
//
// We model this by re-weighting the existing v4 feature stack when a
// player reaches the "race threshold" (12 prestige). No new feature
// functions, just a different weight vector chosen per state.
const RACE_THRESHOLD = 12;
const isEndgame = (state: GameState): boolean =>
  state.players.some((p) => p.prestige >= RACE_THRESHOLD);

const FEATURES_V5_RACE: readonly WeightedFeature[] = [
  { name: 'prestige',                 weight: 2.5, fn: prestigeFeature },
  { name: 'bonus_count',              weight: 0.2, fn: bonusCountFeature },
  { name: 'noble_proximity',          weight: 1.5, fn: nobleProximityFeature },
  { name: 'opponent_threat',          weight: 1.0, fn: opponentThreatFeature },
  { name: 'opponent_noble_proximity', weight: 1.0, fn: opponentNobleProximityFeature },
];

export const evaluateV5: Feature = (state, player) =>
  isEndgame(state)
    ? evaluateWith(FEATURES_V5_RACE, state, player)
    : evaluateWith(FEATURES_V4, state, player);

// === Feature 9: opponent next-buy + noble-chain threat ===
// `opponent_threat` measures *total* affordable prestige across an
// opponent's face-up + reserved options. That treats "they can afford 5
// different cards" as 5× the threat, even though they can only buy one
// next turn. This feature instead asks: of all the cards each opponent
// could buy right now, what's the *worst-case prestige swing* — including
// any noble they'd claim from the buy?
//
// Why noble-chain matters: a player with 4 green bonuses sitting on a
// green-bonus card they can afford is one buy away from +card_prestige
// AND +3 from the matching noble. The existing opponent_threat sees the
// card prestige but completely misses the noble — so the engine cheerfully
// leaves a 7-prestige swing on the board.
//
// Sum across opponents so the threat scales with how many players have
// a strong next move.
export const opponentNextBuyFeature: Feature = (state, me) => {
  let total = 0;
  for (let i = 0; i < state.players.length; i++) {
    if (i === me) continue;
    const opp = state.players[i];
    if (opp === undefined) continue;
    let best = 0;
    const considerCard = (card: Card) => {
      if (computePayment(card, opp) === null) return;
      // Post-buy bonuses: this card just incremented their bonus colour.
      const postBonuses = { ...opp.bonuses, [card.bonus]: opp.bonuses[card.bonus] + 1 };
      // Best noble they'd claim from the post-buy bonus profile (engine
      // auto-awards the first match; treat best as +3 either way since
      // all base-set nobles are worth 3).
      let nobleGain = 0;
      for (const noble of state.nobles) {
        if (meetsNobleRequirement(postBonuses, noble.requirement)) {
          nobleGain = Math.max(nobleGain, noble.prestige);
        }
      }
      best = Math.max(best, card.prestige + nobleGain);
    };
    for (const tier of TIERS) {
      for (const slot of state.faceUp[tier]) {
        if (slot !== null) considerCard(slot);
      }
    }
    for (const r of opp.reserved) considerCard(r.card);
    total += best;
  }
  return total === 0 ? 0 : -total;
};

// V6 = V4 base + opponent_next_buy. The race-mode variant scales the new
// feature too since "1-ply opponent threat" is exactly the kind of signal
// that matters most when the round might end this turn.
export const FEATURES_V6: readonly WeightedFeature[] = [
  ...FEATURES_V4,
  { name: 'opponent_next_buy', weight: 0.5, fn: opponentNextBuyFeature },
];

const FEATURES_V6_RACE: readonly WeightedFeature[] = [
  ...FEATURES_V5_RACE,
  { name: 'opponent_next_buy', weight: 1.5, fn: opponentNextBuyFeature },
];

export const evaluateV6: Feature = (state, player) =>
  isEndgame(state)
    ? evaluateWith(FEATURES_V6_RACE, state, player)
    : evaluateWith(FEATURES_V6, state, player);

// === V7: per-opponent-count normalization ===
// The opponent-summed threat features (opponent_threat,
// opponent_noble_proximity, opponent_next_buy) scale linearly with the
// number of opponents. In 4P they contributed ~3× the magnitude they
// did in 2P, biasing the engine into over-defensive play — both 4P
// agents stalled in 87.5% draws when measured. The fix: divide by the
// opponent count so each feature represents the *average* threat per
// opponent, which keeps the weight vector comparable across player
// counts. Same weights, scale-invariant threat signals.
const normByOpponents = (state: GameState, raw: number): number => {
  const n = state.players.length - 1;
  return n > 0 ? raw / n : 0;
};

export const opponentThreatNormFeature: Feature = (state, me) =>
  normByOpponents(state, opponentThreatFeature(state, me));

export const opponentNobleProximityNormFeature: Feature = (state, me) =>
  normByOpponents(state, opponentNobleProximityFeature(state, me));

export const opponentNextBuyNormFeature: Feature = (state, me) =>
  normByOpponents(state, opponentNextBuyFeature(state, me));

// V7 mid-game: same v4 ingredients + opponent_next_buy, but all three
// opponent features are per-opponent averages.
export const FEATURES_V7: readonly WeightedFeature[] = [
  { name: 'prestige',                      weight: 1.0, fn: prestigeFeature },
  { name: 'bonus_count',                   weight: 0.5, fn: bonusCountFeature },
  { name: 'noble_proximity',               weight: 1.0, fn: nobleProximityFeature },
  { name: 'opponent_threat_norm',          weight: 0.5, fn: opponentThreatNormFeature },
  { name: 'opponent_noble_proximity_norm', weight: 0.5, fn: opponentNobleProximityNormFeature },
  { name: 'opponent_next_buy_norm',        weight: 0.5, fn: opponentNextBuyNormFeature },
];

// V7 race-mode: race-mode weights for prestige/bonus/noble + amplified
// opponent threats (still normalized per-opponent).
const FEATURES_V7_RACE: readonly WeightedFeature[] = [
  { name: 'prestige',                      weight: 2.5, fn: prestigeFeature },
  { name: 'bonus_count',                   weight: 0.2, fn: bonusCountFeature },
  { name: 'noble_proximity',               weight: 1.5, fn: nobleProximityFeature },
  { name: 'opponent_threat_norm',          weight: 1.0, fn: opponentThreatNormFeature },
  { name: 'opponent_noble_proximity_norm', weight: 1.0, fn: opponentNobleProximityNormFeature },
  { name: 'opponent_next_buy_norm',        weight: 1.5, fn: opponentNextBuyNormFeature },
];

export const evaluateV7: Feature = (state, player) =>
  isEndgame(state)
    ? evaluateWith(FEATURES_V7_RACE, state, player)
    : evaluateWith(FEATURES_V7, state, player);

// === Feature 10: self next-buy + noble-chain value ===
// Mirror of opponentNextBuyFeature for the active player. Looks at every
// face-up + reserved card *I* can afford right now and computes the
// max prestige I could grab in one buy (including any noble that buy
// would chain into).
//
// bonusCount already rewards having bonuses, but a 7-bonus pile with no
// gems is useless this turn. This feature captures "the gems I have +
// the cards I see make me one move away from N prestige" — a near-term,
// action-grounded signal that bonusCount can't represent.
export const selfNextBuyFeature: Feature = (state, me) => {
  const player = state.players[me];
  if (player === undefined) return 0;
  let best = 0;
  const considerCard = (card: Card, isReserved: boolean) => {
    if (computePayment(card, player) === null) return;
    // Competition discount: face-up cards can be snatched by anyone who can
    // afford them, so a card that 3 opponents can also buy is worth roughly
    // 1/(N+1) of its face value to me. Reserved cards are mine alone — no
    // discount. Without this, in 4P the agent over-races to high-prestige
    // shared cards that it usually won't end up getting.
    let discount = 1;
    if (!isReserved) {
      let competitors = 0;
      for (let i = 0; i < state.players.length; i++) {
        if (i === me) continue;
        const opp = state.players[i];
        if (opp === undefined) continue;
        if (computePayment(card, opp) !== null) competitors++;
      }
      discount = 1 / (1 + competitors);
    }
    const postBonuses = { ...player.bonuses, [card.bonus]: player.bonuses[card.bonus] + 1 };
    let nobleGain = 0;
    for (const noble of state.nobles) {
      if (meetsNobleRequirement(postBonuses, noble.requirement)) {
        nobleGain = Math.max(nobleGain, noble.prestige);
      }
    }
    best = Math.max(best, (card.prestige + nobleGain) * discount);
  };
  for (const tier of TIERS) {
    for (const slot of state.faceUp[tier]) {
      if (slot !== null) considerCard(slot, false);
    }
  }
  for (const r of player.reserved) considerCard(r.card, true);
  return best;
};

// V8 mid-game: V7 + self_next_buy. selfNextBuyFeature already does its
// own competition discount per-card (1/(N+1) where N = opponents who
// could also afford that face-up card), so the global weight can stay
// at 0.5 — the player-count adjustment lives inside the feature rather
// than in the weight.
export const FEATURES_V8: readonly WeightedFeature[] = [
  ...FEATURES_V7,
  { name: 'self_next_buy', weight: 0.5, fn: selfNextBuyFeature },
];

const FEATURES_V8_RACE: readonly WeightedFeature[] = [
  ...FEATURES_V7_RACE,
  { name: 'self_next_buy', weight: 1.5, fn: selfNextBuyFeature },
];

export const evaluateV8: Feature = (state, player) =>
  isEndgame(state)
    ? evaluateWith(FEATURES_V8_RACE, state, player)
    : evaluateWith(FEATURES_V8, state, player);

// Ordered list of tunable mid-game features. Used by the coordinate-descent
// tuner (src/cli/tune.ts) AND by the agentFactory's 'tunable:...' parser,
// so the index order must match. v8 defaults are the baseline the tuner
// starts from.
export const TUNABLE_FEATURES: readonly { name: string; fn: Feature; v8: number }[] = [
  { name: 'prestige',                      fn: prestigeFeature,                   v8: 1.0 },
  { name: 'bonus_count',                   fn: bonusCountFeature,                 v8: 0.5 },
  { name: 'noble_proximity',               fn: nobleProximityFeature,             v8: 1.0 },
  { name: 'opponent_threat_norm',          fn: opponentThreatNormFeature,         v8: 0.5 },
  { name: 'opponent_noble_proximity_norm', fn: opponentNobleProximityNormFeature, v8: 0.5 },
  { name: 'opponent_next_buy_norm',        fn: opponentNextBuyNormFeature,        v8: 0.5 },
  { name: 'self_next_buy',                 fn: selfNextBuyFeature,                v8: 0.5 },
];

/**
 * Build an evaluator from an arbitrary weight vector over TUNABLE_FEATURES.
 * Used by the parallel tuner: workers reconstruct the candidate evaluator
 * from a comma-separated weights string passed as the agent descriptor.
 */
export const evaluatorFromWeights = (weights: readonly number[]): Feature => {
  const features: WeightedFeature[] = TUNABLE_FEATURES.map((f, i) => ({
    name: f.name,
    weight: weights[i] ?? 0,
    fn: f.fn,
  }));
  return (state, player) => evaluateWith(features, state, player);
};

// `evaluate` always points at the current best evaluator. v7 (v6 with
// opponent features normalized by opponent count) currently leads. v6
// regressed in 4P (−5pp vs v3) because the summed opponent_*  features
// scaled with player count and biased the agent into over-defensive
// play. v7 fixes that: tournament shows +3.8pp vs v3 *consistently
// across 2P/3P/4P*. Rejected en route under depth-1 greedy:
// concentration (Experiment 3), engine_value (Experiment 4),
// gem_pressure (Experiment 5). See diary/phase-01-evaluator.md.
export const evaluate: Feature = evaluateV8;

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
