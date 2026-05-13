import { applyTurn, isTerminal, winner } from './apply';
import { evaluate } from './evaluate';
import type { Feature } from './evaluate';
import { legalActions } from './legalActions';
import type { Rng } from './setup';
import type { Action, GameState, PlayerIndex } from './types';

export type MctsOptions = {
  /** Number of MCTS iterations. Mutually exclusive with `timeMs`. */
  iterations?: number;
  /** Wall-clock budget in ms. Mutually exclusive with `iterations`. */
  timeMs?: number;
  /** Cap random rollout length (turns) before evaluating the leaf state. */
  rolloutDepth?: number;
  /** Leaf evaluator used to score rollout end states that aren't terminal. */
  evalFn?: Feature;
  /** RNG for rollout action selection. */
  rng?: Rng;
  /** UCB1 exploration constant. Standard is sqrt(2). */
  c?: number;
};

/**
 * One node in the MCTS tree. Children are kept in a plain array; the
 * action that led to each child is on the child itself. `totalReward` is
 * a vector indexed by player so the same tree generalizes from 2 to 4
 * players naturally.
 *
 * `currentPlayer` is whoever is about to move *at this node's state*. The
 * UCB1 selection at this node picks the child that maximizes the parent's
 * — i.e., this node's — perspective.
 */
type Node = {
  currentPlayer: PlayerIndex;
  parent: Node | null;
  parentAction: Action | null;
  children: Node[];
  untriedActions: Action[];
  visits: number;
  totalReward: number[];
};

const makeNode = (
  state: GameState,
  parent: Node | null,
  parentAction: Action | null,
): Node => ({
  currentPlayer: state.currentPlayer,
  parent,
  parentAction,
  children: [],
  untriedActions: legalActions(state),
  visits: 0,
  totalReward: new Array(state.players.length).fill(0),
});

const ucb1 = (
  child: Node,
  parentVisits: number,
  parentPlayer: PlayerIndex,
  c: number,
): number => {
  if (child.visits === 0) return Number.POSITIVE_INFINITY;
  const reward = child.totalReward[parentPlayer];
  if (reward === undefined) return Number.POSITIVE_INFINITY;
  const exploit = reward / child.visits;
  const explore = c * Math.sqrt(Math.log(parentVisits) / child.visits);
  return exploit + explore;
};

const pickByUCB1 = (node: Node, c: number): Node => {
  let best = node.children[0];
  if (best === undefined) throw new Error('pickByUCB1: no children');
  let bestScore = ucb1(best, node.visits, node.currentPlayer, c);
  for (let i = 1; i < node.children.length; i++) {
    const child = node.children[i];
    if (child === undefined) continue;
    const score = ucb1(child, node.visits, node.currentPlayer, c);
    if (score > bestScore) {
      bestScore = score;
      best = child;
    }
  }
  return best;
};

/**
 * Squash an evaluator score to [0, 1] so it can be averaged with terminal
 * outcomes (0 / 1) during backprop. The 1/5 scale is a starting heuristic;
 * Splendor evaluator scores typically range 0..30 in non-terminal states,
 * and sigmoid(30/5) ≈ 0.998 so winning evaluations saturate appropriately.
 */
const squash = (x: number): number => 1 / (1 + Math.exp(-x / 5));

const rollout = (
  state: GameState,
  evalFn: Feature,
  maxTurns: number,
  rng: Rng,
): number[] => {
  let s = state;
  let turns = 0;
  while (!isTerminal(s) && turns < maxTurns) {
    const actions = legalActions(s);
    if (actions.length === 0) break;
    const idx = Math.floor(rng() * actions.length);
    const action = actions[idx];
    if (action === undefined) break;
    s = applyTurn(s, action);
    turns++;
  }
  const out: number[] = new Array(s.players.length);
  if (isTerminal(s)) {
    const w = winner(s);
    for (let i = 0; i < s.players.length; i++) out[i] = i === w ? 1 : 0;
    return out;
  }
  for (let i = 0; i < s.players.length; i++) {
    out[i] = squash(evalFn(s, i as PlayerIndex));
  }
  return out;
};

const backpropagate = (leaf: Node, reward: number[]): void => {
  let node: Node | null = leaf;
  while (node !== null) {
    node.visits += 1;
    for (let p = 0; p < reward.length; p++) {
      const r = reward[p];
      const t = node.totalReward[p];
      if (r === undefined || t === undefined) continue;
      node.totalReward[p] = t + r;
    }
    node = node.parent;
  }
};

const DEFAULT_C = Math.sqrt(2);
const DEFAULT_ROLLOUT_DEPTH = 20;

/**
 * Run MCTS from `rootState` for the requested budget (iterations or wall
 * time) and return the most-visited root child's action.
 *
 * "Most visited" rather than "highest mean reward": when iterations are
 * limited, visit count is a more stable signal than mean reward, since
 * a child visited only a handful of times can have wildly variable mean.
 */
export const mctsBestAction = (
  rootState: GameState,
  options: MctsOptions,
): Action => {
  const evalFn = options.evalFn ?? evaluate;
  const rng = options.rng ?? Math.random;
  const c = options.c ?? DEFAULT_C;
  const rolloutDepth = options.rolloutDepth ?? DEFAULT_ROLLOUT_DEPTH;
  const root = makeNode(rootState, null, null);
  if (root.untriedActions.length === 0) {
    throw new Error('mctsBestAction: no legal actions at root');
  }

  const deadline = options.timeMs !== undefined ? Date.now() + options.timeMs : undefined;
  const maxIter = options.iterations ?? (deadline === undefined ? 1000 : Number.MAX_SAFE_INTEGER);

  for (let iter = 0; iter < maxIter; iter++) {
    if (deadline !== undefined && Date.now() >= deadline) break;

    let node = root;
    let state = rootState;

    // Selection + Expansion.
    while (true) {
      if (isTerminal(state)) break;
      if (node.untriedActions.length > 0) {
        // Expand by taking one untried action; pop from the front so the
        // first iteration gets the first legal action (mostly cosmetic).
        const action = node.untriedActions.shift();
        if (action === undefined) break;
        state = applyTurn(state, action);
        const child = makeNode(state, node, action);
        node.children.push(child);
        node = child;
        break;
      }
      if (node.children.length === 0) break;
      const next = pickByUCB1(node, c);
      const action = next.parentAction;
      if (action === null) break;
      state = applyTurn(state, action);
      node = next;
    }

    // Simulation.
    const reward = rollout(state, evalFn, rolloutDepth, rng);

    // Backpropagation.
    backpropagate(node, reward);
  }

  let best = root.children[0];
  if (best === undefined) {
    throw new Error('mctsBestAction: no expansions performed');
  }
  for (let i = 1; i < root.children.length; i++) {
    const child = root.children[i];
    if (child === undefined) continue;
    if (child.visits > best.visits) best = child;
  }
  const action = best.parentAction;
  if (action === null) {
    throw new Error('mctsBestAction: best child has no parentAction');
  }
  return action;
};
