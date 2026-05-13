import { applyTurn } from './apply';
import { evaluate } from './evaluate';
import { legalActions } from './legalActions';
import { mctsBestAction, type RolloutPolicy } from './mcts';
import { searchBestAction } from './search';
import type { Rng } from './setup';
import type { Action, GameState } from './types';

/** An agent picks one action given the current state. Deterministic by default. */
export type Agent = (state: GameState) => Action;

export type Evaluator = (state: GameState, player: 0 | 1 | 2 | 3) => number;

/** Picks any legal action uniformly at random. */
export const randomAgent = (rng: Rng): Agent => (state) => {
  const actions = legalActions(state);
  if (actions.length === 0) {
    throw new Error('randomAgent: no legal actions');
  }
  const idx = Math.floor(rng() * actions.length);
  const choice = actions[idx];
  if (choice === undefined) throw new Error('randomAgent: rng out of range');
  return choice;
};

/**
 * For each legal action, applies the action (with deterministic top-of-deck
 * reveal), evaluates the resulting state from the active player's perspective,
 * and picks the highest-scoring action. Ties resolve to the first encountered.
 *
 * `evalFn` defaults to the baseline `evaluate`. Pass a different evaluator to
 * test a feature without changing the agent.
 */
export const greedyAgent = (evalFn: Evaluator = evaluate): Agent => (state) => {
  const me = state.currentPlayer;
  const actions = legalActions(state);
  if (actions.length === 0) {
    throw new Error('greedyAgent: no legal actions');
  }
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a === undefined) continue;
    const next = applyTurn(state, a);
    const score = evalFn(next, me);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const choice = actions[bestIdx];
  if (choice === undefined) throw new Error('greedyAgent: empty action list');
  return choice;
};

/**
 * Multi-player max-N search to a fixed depth, using `evalFn` at the leaves.
 * `depth=1` is equivalent to greedy (the leaf is the post-action state, and
 * we maximize over candidate actions). `depth=2` simulates the opponent's
 * best response. `depth=3` simulates one more ply.
 *
 * Branching factor in Splendor is roughly 20–30 actions per turn, so depth
 * costs roughly that exponentially. depth=2 is fast; depth=3 needs alpha-beta.
 */
export const searchAgent = (depth: number, evalFn: Evaluator = evaluate): Agent =>
  (state) => searchBestAction(state, { depth, evalFn });

/**
 * Iterative-deepening search with a fixed wall-clock budget per move.
 * Searches depth 1, 2, 3, ... until the budget runs out, returning the
 * deepest completed depth's best action. More user-friendly than fixed-depth
 * search for interactive use ("spend up to 500ms thinking").
 */
export const iterativeAgent = (timeMs: number, evalFn: Evaluator = evaluate): Agent =>
  (state) => searchBestAction(state, { timeMs, evalFn });

/**
 * MCTS with UCB1 selection and depth-capped rollouts.
 * `iterations` controls the budget; `evalFn` evaluates rollout endpoints
 * that aren't terminal; `rng` controls rollout choices; `policy` selects
 * between heuristic (Splendor-priority) and pure random rollouts.
 */
export const mctsAgent = (
  iterations: number,
  evalFn: Evaluator = evaluate,
  rng: Rng = Math.random,
  policy: RolloutPolicy = 'heuristic',
): Agent => (state) =>
  mctsBestAction(state, { iterations, evalFn, rng, rolloutPolicy: policy });

/** Same as mctsAgent but with a wall-clock budget instead of iteration count. */
export const mctsTimeAgent = (
  timeMs: number,
  evalFn: Evaluator = evaluate,
  rng: Rng = Math.random,
  policy: RolloutPolicy = 'heuristic',
): Agent => (state) =>
  mctsBestAction(state, { timeMs, evalFn, rng, rolloutPolicy: policy });
