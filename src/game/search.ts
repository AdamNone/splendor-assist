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

// =============================================================================
// Multi-player max-N (used for 3-4 player matches)
// =============================================================================

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
 * Trade-off vs alpha-beta: max-N has no clean pruning rule (each player
 * has a different objective), so it's strictly slower. We accept that for
 * 3-4 player matches where alpha-beta would be wrong (paranoid pruning
 * implies coalition between opponents, which over-prunes the search tree).
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

const maxNSearch = (state: GameState, options: SearchOptions): Action => {
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

// =============================================================================
// 2-player paranoid alpha-beta
// =============================================================================

/**
 * Alpha-beta search from `me`'s perspective. At `me`'s turns we maximize
 * `evalFn(state, me)`; at the opponent's turns we minimize it (paranoid
 * model — assume the opponent picks whatever is worst for `me`).
 *
 * Splendor isn't strictly zero-sum, but it's close: a player only wins by
 * reaching 15 first, so each player's incentive is to slow the others down.
 * Paranoid pruning is a pragmatic fit and gets us proper alpha-beta cuts.
 *
 * For 3+ players this would over-prune (it implies coalition); the
 * dispatcher in `searchBestAction` falls back to max-N in that case.
 */
const alphaBeta = (
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
  me: PlayerIndex,
  evalFn: Feature,
): number => {
  if (depth === 0 || isTerminal(state)) return evalFn(state, me);
  const actions = legalActions(state);
  if (actions.length === 0) return evalFn(state, me);
  const isMaximizer = state.currentPlayer === me;

  if (isMaximizer) {
    let value = -Infinity;
    let a = alpha;
    for (const action of actions) {
      const next = applyTurn(state, action);
      const score = alphaBeta(next, depth - 1, a, beta, me, evalFn);
      if (score > value) value = score;
      if (value >= beta) break; // beta cutoff
      if (value > a) a = value;
    }
    return value;
  }

  let value = +Infinity;
  let b = beta;
  for (const action of actions) {
    const next = applyTurn(state, action);
    const score = alphaBeta(next, depth - 1, alpha, b, me, evalFn);
    if (score < value) value = score;
    if (value <= alpha) break; // alpha cutoff
    if (value < b) b = value;
  }
  return value;
};

const alphaBetaSearch = (state: GameState, options: SearchOptions): Action => {
  const evalFn = options.evalFn ?? evaluate;
  const actions = legalActions(state);
  if (actions.length === 0) {
    throw new Error('searchBestAction: no legal actions');
  }
  const me = state.currentPlayer;
  let bestAction = actions[0];
  if (bestAction === undefined) throw new Error('searchBestAction: empty list');
  let bestScore = -Infinity;
  let alpha = -Infinity;
  const beta = +Infinity;

  for (const action of actions) {
    const next = applyTurn(state, action);
    const score = alphaBeta(next, options.depth - 1, alpha, beta, me, evalFn);
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
    }
    if (score > alpha) alpha = score;
  }
  return bestAction;
};

// =============================================================================
// Dispatcher
// =============================================================================

/**
 * Pick the best action for the active player.
 *
 * Algorithm choice depends on player count and search depth:
 *
 *   - 2-player at depth ≥ 3: paranoid alpha-beta. Pruning makes depth 3
 *     feasible (~200 ms/turn instead of ~2 s without). Empirically the
 *     extra ply of foresight more than compensates for the paranoid model
 *     error vs. max-N (tournament: search-d3 beats greedy(v3) by +44 pp;
 *     plain max-N at d3 is too slow to run).
 *   - 2-player at depth ≤ 2: max-N. Faster than alpha-beta at d2 *and*
 *     more accurate (the paranoid model assumes opp minimizes our eval,
 *     but the actual opponent maximizes its own; the difference matters
 *     more at shallow depths than the pruning saves).
 *   - 3+ players: max-N. Paranoid alpha-beta would over-prune by
 *     implying coalition between opponents.
 *
 * `depth=1` is equivalent to greedy in all cases.
 */
export const searchBestAction = (
  state: GameState,
  options: SearchOptions,
): Action => {
  if (state.numPlayers === 2 && options.depth >= 3) {
    return alphaBetaSearch(state, options);
  }
  return maxNSearch(state, options);
};
