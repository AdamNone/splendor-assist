import { applyTurn, isTerminal } from './apply';
import { evaluate } from './evaluate';
import type { Feature } from './evaluate';
import { legalActions } from './legalActions';
import type { Action, GameState, PlayerIndex } from './types';

export type SearchOptions = {
  /** Search to a fixed depth. Mutually exclusive with `timeMs`. */
  depth?: number;
  /** Iterative deepening with this time budget (ms). Mutually exclusive with `depth`. */
  timeMs?: number;
  /** Leaf evaluator. Defaults to the current best (`evaluate`). */
  evalFn?: Feature;
};

/**
 * Thrown by recursive search calls when the iterative-deepening deadline
 * has passed. The outer loop catches it and falls back to the previous
 * completed depth's best move.
 */
class SearchTimeout extends Error {
  constructor() {
    super('search timeout');
    this.name = 'SearchTimeout';
  }
}

const overDeadline = (deadline: number | undefined): boolean =>
  deadline !== undefined && Date.now() >= deadline;

const checkDeadline = (deadline: number | undefined): void => {
  if (overDeadline(deadline)) throw new SearchTimeout();
};

const evalVec = (state: GameState, evalFn: Feature): number[] => {
  const out: number[] = new Array(state.players.length);
  for (let i = 0; i < state.players.length; i++) {
    out[i] = evalFn(state, i as PlayerIndex);
  }
  return out;
};

/**
 * Sort actions by 1-ply evaluator score (descending) from the active
 * player's perspective. Used for move ordering at the root: alpha-beta
 * prunes more when likely-best moves are tried first, and even max-N
 * benefits because it short-circuits the "is this the new best?" check
 * earlier on average.
 */
const sortedByScore = (
  state: GameState,
  actions: Action[],
  evalFn: Feature,
): Action[] => {
  const me = state.currentPlayer;
  const scored = actions.map((a) => ({
    a,
    score: evalFn(applyTurn(state, a), me),
  }));
  scored.sort((x, y) => y.score - x.score);
  return scored.map((s) => s.a);
};

// =============================================================================
// Multi-player max-N
// =============================================================================

const maxN = (
  state: GameState,
  depth: number,
  evalFn: Feature,
  deadline: number | undefined,
): number[] => {
  checkDeadline(deadline);
  if (depth === 0 || isTerminal(state)) return evalVec(state, evalFn);
  const actions = legalActions(state);
  if (actions.length === 0) return evalVec(state, evalFn);
  const me = state.currentPlayer;
  let best: number[] | null = null;
  let bestForMe = -Infinity;
  for (const action of actions) {
    const next = applyTurn(state, action);
    const vec = maxN(next, depth - 1, evalFn, deadline);
    const myScore = vec[me];
    if (myScore !== undefined && myScore > bestForMe) {
      bestForMe = myScore;
      best = vec;
    }
  }
  return best ?? evalVec(state, evalFn);
};

const maxNSearch = (
  state: GameState,
  evalFn: Feature,
  depth: number,
  deadline: number | undefined,
): Action => {
  const actions = legalActions(state);
  if (actions.length === 0) throw new Error('searchBestAction: no legal actions');
  // Root move ordering only applies for depth ≥ 2 (at depth 1 it's wasted work).
  const ordered = depth >= 2 ? sortedByScore(state, actions, evalFn) : actions;
  const me = state.currentPlayer;
  let bestAction = ordered[0];
  if (bestAction === undefined) throw new Error('searchBestAction: empty list');
  let bestScore = -Infinity;
  for (const action of ordered) {
    const next = applyTurn(state, action);
    const vec = maxN(next, depth - 1, evalFn, deadline);
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

const alphaBeta = (
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
  me: PlayerIndex,
  evalFn: Feature,
  deadline: number | undefined,
): number => {
  checkDeadline(deadline);
  if (depth === 0 || isTerminal(state)) return evalFn(state, me);
  const actions = legalActions(state);
  if (actions.length === 0) return evalFn(state, me);
  const isMaximizer = state.currentPlayer === me;

  if (isMaximizer) {
    let value = -Infinity;
    let a = alpha;
    for (const action of actions) {
      const next = applyTurn(state, action);
      const score = alphaBeta(next, depth - 1, a, beta, me, evalFn, deadline);
      if (score > value) value = score;
      if (value >= beta) break;
      if (value > a) a = value;
    }
    return value;
  }

  let value = +Infinity;
  let b = beta;
  for (const action of actions) {
    const next = applyTurn(state, action);
    const score = alphaBeta(next, depth - 1, alpha, b, me, evalFn, deadline);
    if (score < value) value = score;
    if (value <= alpha) break;
    if (value < b) b = value;
  }
  return value;
};

const alphaBetaSearch = (
  state: GameState,
  evalFn: Feature,
  depth: number,
  deadline: number | undefined,
): Action => {
  const actions = legalActions(state);
  if (actions.length === 0) throw new Error('searchBestAction: no legal actions');
  const ordered = depth >= 2 ? sortedByScore(state, actions, evalFn) : actions;
  const me = state.currentPlayer;
  let bestAction = ordered[0];
  if (bestAction === undefined) throw new Error('searchBestAction: empty list');
  let bestScore = -Infinity;
  let alpha = -Infinity;
  const beta = +Infinity;

  for (const action of ordered) {
    const next = applyTurn(state, action);
    const score = alphaBeta(next, depth - 1, alpha, beta, me, evalFn, deadline);
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
    }
    if (score > alpha) alpha = score;
  }
  return bestAction;
};

// =============================================================================
// Dispatcher and iterative deepening
// =============================================================================

const fixedDepthSearch = (
  state: GameState,
  evalFn: Feature,
  depth: number,
  deadline: number | undefined,
): Action => {
  if (state.numPlayers === 2 && depth >= 3) {
    return alphaBetaSearch(state, evalFn, depth, deadline);
  }
  return maxNSearch(state, evalFn, depth, deadline);
};

/**
 * Iteratively deepen depth=1, 2, 3, ... until the time budget is used up
 * or a hard depth ceiling is hit. The action returned is the best from the
 * deepest *completed* depth — partially-completed deeper searches are
 * discarded.
 *
 * Why a depth ceiling at all: if Splendor enters a state with very few
 * legal actions, depth 6+ becomes feasible and we'd loop forever.
 */
const iterativeDeepening = (
  state: GameState,
  evalFn: Feature,
  timeMs: number,
): Action => {
  const deadline = Date.now() + timeMs;
  const actions = legalActions(state);
  if (actions.length === 0) throw new Error('searchBestAction: no legal actions');
  let bestAction = actions[0];
  if (bestAction === undefined) throw new Error('searchBestAction: empty list');
  const ceiling = 8;

  for (let depth = 1; depth <= ceiling; depth++) {
    try {
      bestAction = fixedDepthSearch(state, evalFn, depth, deadline);
    } catch (e) {
      if (e instanceof SearchTimeout) return bestAction;
      throw e;
    }
    if (overDeadline(deadline)) break;
  }
  return bestAction;
};

/**
 * Pick the best action for the active player.
 *
 * Modes:
 *   - `{ depth }` — fixed-depth search.
 *   - `{ timeMs }` — iterative deepening within the time budget.
 *
 * Algorithm chosen automatically:
 *   - 2 players + depth ≥ 3 → paranoid alpha-beta (with root move ordering).
 *   - everywhere else       → max-N (with root move ordering at depth ≥ 2).
 *
 * `depth=1` is equivalent to greedy in all cases.
 */
export const searchBestAction = (
  state: GameState,
  options: SearchOptions,
): Action => {
  const evalFn = options.evalFn ?? evaluate;
  if (options.timeMs !== undefined) {
    return iterativeDeepening(state, evalFn, options.timeMs);
  }
  if (options.depth !== undefined) {
    return fixedDepthSearch(state, evalFn, options.depth, undefined);
  }
  throw new Error('searchBestAction: must provide depth or timeMs');
};
