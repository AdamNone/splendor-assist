import { applyTurn } from './apply';
import { evaluate } from './evaluate';
import { legalActions } from './legalActions';
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
