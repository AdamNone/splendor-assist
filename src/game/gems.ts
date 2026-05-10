import { COLORS, GEM_COLORS } from './types';
import type { Card, ColorCount, GemPool, PlayerState } from './types';

export const emptyColorCount = (): ColorCount => ({
  white: 0,
  blue: 0,
  green: 0,
  red: 0,
  black: 0,
});

export const emptyGemPool = (): GemPool => ({
  white: 0,
  blue: 0,
  green: 0,
  red: 0,
  black: 0,
  gold: 0,
});

export const totalGems = (pool: GemPool): number =>
  GEM_COLORS.reduce((sum, c) => sum + pool[c], 0);

// Recompute helpers. The engine maintains player.bonuses and player.prestige
// incrementally; these are used at game setup and as test invariants.
export const recomputeBonuses = (player: PlayerState): ColorCount => {
  const bonuses = emptyColorCount();
  for (const card of player.purchased) {
    bonuses[card.bonus] += 1;
  }
  return bonuses;
};

export const recomputePrestige = (player: PlayerState): number => {
  let total = 0;
  for (const card of player.purchased) total += card.prestige;
  for (const noble of player.nobles) total += noble.prestige;
  return total;
};

/**
 * Minimum gems of each color the player must spend to buy `card`,
 * given their current bonuses, plus the number of gold wildcards needed.
 * Returns null if the player cannot afford the card even with gold.
 */
export const computePayment = (
  card: Card,
  player: PlayerState,
): GemPool | null => {
  const payment = emptyGemPool();
  let goldNeeded = 0;
  for (const color of COLORS) {
    const cost = card.cost[color];
    const discount = player.bonuses[color];
    const owed = Math.max(0, cost - discount);
    const fromColored = Math.min(owed, player.gems[color]);
    payment[color] = fromColored;
    goldNeeded += owed - fromColored;
  }
  if (goldNeeded > player.gems.gold) return null;
  payment.gold = goldNeeded;
  return payment;
};

export const meetsNobleRequirement = (
  bonuses: ColorCount,
  requirement: ColorCount,
): boolean => COLORS.every((c) => bonuses[c] >= requirement[c]);
