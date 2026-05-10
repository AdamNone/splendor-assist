import { COLORS } from './types';
import type { GameState, PlayerIndex } from './types';
import { isTerminal, winner } from './apply';

/**
 * Score awarded to a winning player at a terminal state. Large enough that
 * any winning state is preferred over any non-terminal state, and any
 * non-terminal state is preferred over any losing state.
 */
export const TERMINAL_WIN = 1000;
export const TERMINAL_LOSS = -1000;

/**
 * Baseline evaluator (Phase 1 v1). Returns a real number; higher is better
 * for the given player.
 *
 *   evaluate = prestige + 0.5 * bonus_count   (non-terminal)
 *   evaluate = ±1000                          (terminal — see consts above)
 *
 * Bonuses get a sub-prestige weight on purpose: a card buys you future
 * discounts, but the literal score is prestige. The 0.5 multiplier is a
 * starting point we'll tune as we add features in subsequent phases.
 */
export const evaluate = (state: GameState, player: PlayerIndex): number => {
  if (isTerminal(state)) {
    return winner(state) === player ? TERMINAL_WIN : TERMINAL_LOSS;
  }
  const p = state.players[player];
  if (p === undefined) return 0;
  let bonuses = 0;
  for (const c of COLORS) bonuses += p.bonuses[c];
  return p.prestige + 0.5 * bonuses;
};
