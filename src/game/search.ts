import { applyTurn, isTerminal } from './apply';
import { evaluate } from './evaluate';
import type { Feature } from './evaluate';
import { legalActions } from './legalActions';
import type { Action, GameState, PlayerIndex } from './types';

export type SearchOptions = {
  /** Number of plies to look ahead. depth=1 is equivalent to 1-ply greedy. */
  depth: number;
  /** Leaf evaluator. Defaults to the current best (`evaluate`). */
  evalFn?: Feature;
};

/**
 * Build a vector of leaf scores indexed by player. Used by max-N to track
 * each player's utility at a given state.
 */
const evalVec = (state: GameState, evalFn: Feature): number[] => {
  const out: number[] = new Array(state.players.length);
  for (let i = 0; i < state.players.length; i++) {
    out[i] = evalFn(state, i as PlayerIndex);
  }
  return out;
};

/**
 * Multi-player max-N. Recursively expand legal actions; at each node, the
 * player whose turn it is picks the action that maximizes their *own* leaf
 * score; the returned vector carries every player's leaf score under that
 * choice.
 *
 * For 2-player games this is identical to minimax under the assumption
 * that the opponent maximizes their own score (which, in Splendor, equals
 * minimizing yours up to a constant — close enough at our skill levels).
 *
 * Reveals are resolved deterministically via `applyTurn` (top of deck).
 * Phase 3 ISMCTS will handle the stochasticity properly.
 */
const maxN = (state: GameState, depth: number, evalFn: Feature): number[] => {
  if (depth === 0 || isTerminal(state)) return evalVec(state, evalFn);
  const actions = legalActions(state);
  if (actions.length === 0) return evalVec(state, evalFn);
  const me = state.currentPlayer;
  let best: number[] | null = null;
  let bestForMe = -Infinity;
  for (const action of actions) {
    const next = applyTurn(state, action);
    const vec = maxN(next, depth - 1, evalFn);
    const myScore = vec[me];
    if (myScore !== undefined && myScore > bestForMe) {
      bestForMe = myScore;
      best = vec;
    }
  }
  return best ?? evalVec(state, evalFn);
};

/**
 * Pick the action that maximizes the active player's utility under
 * `depth`-ply max-N search.
 *
 * Throws if there are no legal actions.
 */
export const searchBestAction = (
  state: GameState,
  options: SearchOptions,
): Action => {
  const evalFn = options.evalFn ?? evaluate;
  const actions = legalActions(state);
  if (actions.length === 0) {
    throw new Error('searchBestAction: no legal actions');
  }
  const me = state.currentPlayer;
  let bestAction = actions[0];
  if (bestAction === undefined) throw new Error('searchBestAction: empty list');
  let bestScore = -Infinity;
  for (const action of actions) {
    const next = applyTurn(state, action);
    const vec = maxN(next, options.depth - 1, evalFn);
    const myScore = vec[me];
    if (myScore !== undefined && myScore > bestScore) {
      bestScore = myScore;
      bestAction = action;
    }
  }
  return bestAction;
};
