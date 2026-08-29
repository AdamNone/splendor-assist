import { applyTurn, isTerminal, winner } from './apply';
import { evaluate } from './evaluate';
import type { Feature } from './evaluate';
import { legalActions } from './legalActions';
import type { Rng } from './setup';
import type { Action, Card, GameState, PlayerIndex } from './types';

export type RolloutPolicy = 'random' | 'heuristic';

/**
 * How a rollout's end state is turned into a reward vector.
 *
 *   'binary'     — original scheme: 1/0 at decided games, squashed absolute
 *                  evaluator score otherwise. Kept so we can A/B against it.
 *   'discounted' — banded and depth-aware (see `terminalReward`). Default.
 */
export type RewardShaping = 'binary' | 'discounted';

export type MctsOptions = {
  /** Number of MCTS iterations. Mutually exclusive with `timeMs`. */
  iterations?: number;
  /** Wall-clock budget in ms. Mutually exclusive with `iterations`. */
  timeMs?: number;
  /** Cap rollout length (turns) before evaluating the leaf state. */
  rolloutDepth?: number;
  /** Leaf evaluator used to score rollout end states that aren't terminal. */
  evalFn?: Feature;
  /** RNG for rollout action selection. */
  rng?: Rng;
  /** UCB1 exploration constant. Standard is sqrt(2). */
  c?: number;
  /** How rollouts pick actions. 'heuristic' is the new (Phase 3 v2) default. */
  rolloutPolicy?: RolloutPolicy;
  /** How leaf states are scored. See `RewardShaping`. */
  rewardShaping?: RewardShaping;
  /**
   * ISMCTS-style deck shuffling. When true, each iteration begins by
   * shuffling every tier's deck so the agent reasons about deck order as
   * unknown rather than relying on the deterministic top-of-deck reveals
   * the engine produces. v1 handles deck order only; opponents' blind
   * reserves are still visible (Phase 3 v2 will tackle those).
   */
  determinization?: boolean;
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
  /** Plies from the root. Rollouts add their own length to this so that
   *  "how soon does this line finish" is measured from the root, not from
   *  wherever in the tree the rollout happened to start. */
  depth: number;
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
  depth: parent === null ? 0 : parent.depth + 1,
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
 *
 * Only used by the 'binary' shaping now — that saturation turned out to be
 * a liability, see the band comment below.
 */
const squash = (x: number): number => 1 / (1 + Math.exp(-x / 5));

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Reward bands for the 'discounted' shaping.
 *
 * Every leaf value lands in [0, 1], and the three kinds of leaf are kept in
 * strictly separated ranges:
 *
 *   lost game      [0, BAND_LO)
 *   undecided      [BAND_LO, BAND_HI]   — rollout hit the depth cap
 *   won game       (BAND_HI, 1]
 *
 * The separation matters: under the old scheme a *heuristic estimate* could
 * outscore an actual win, because squash() saturates to ~0.998 for any decent
 * position while a win is 1.0.
 *
 * Inside the win band the value decays with the number of plies the line took,
 * so winning in three moves beats winning in ten. Without that decay every
 * winning line scores exactly 1.0. That is not a rounding artefact — in the
 * position that prompted this change, 16 of 30 root moves scored exactly 1.0
 * with identical visit counts, so the search had nothing to choose between a
 * +7 prestige buy and `take3`, and picked whichever it expanded first.
 */
const BAND_LO = 0.35;
const BAND_HI = 0.65;
/**
 * Band edges, exported so the UI can explain what a candidate's score means:
 * above `hi` the search reached a win in most simulations, below `lo` it
 * reached a loss, in between the rollouts ran out of depth and the number is
 * a heuristic estimate.
 */
export const REWARD_BANDS = { lo: BAND_LO, hi: BAND_HI } as const;
/** Per-ply decay applied to decided games. */
const SPEED_DECAY = 0.85;
/**
 * Sigmoid width for an undecided leaf, in evaluator points of *margin* (my
 * score minus the best opponent's). Absolute scores run 0..40 and saturate
 * any sigmoid; the margin is centred on 0 and rarely leaves ±20.
 */
const MARGIN_SCALE = 8;

/** Reward vector for a decided game, `plies` from the root. */
const terminalReward = (
  numPlayers: number,
  winnerIdx: PlayerIndex,
  plies: number,
): number[] => {
  const speed = SPEED_DECAY ** plies;
  const win = BAND_HI + (1 - BAND_HI) * speed;
  const loss = BAND_LO * (1 - speed);
  const out = new Array<number>(numPlayers);
  for (let i = 0; i < numPlayers; i++) out[i] = i === winnerIdx ? win : loss;
  return out;
};

/** Reward vector for an undecided game: each player's evaluator margin. */
const estimateReward = (state: GameState, evalFn: Feature): number[] => {
  const n = state.players.length;
  const scores = new Array<number>(n);
  for (let i = 0; i < n; i++) scores[i] = evalFn(state, i as PlayerIndex);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let bestOther = -Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const s = scores[j];
      if (s !== undefined && s > bestOther) bestOther = s;
    }
    const mine = scores[i] ?? 0;
    const margin = Number.isFinite(bestOther) ? mine - bestOther : 0;
    out[i] = BAND_LO + (BAND_HI - BAND_LO) * sigmoid(margin / MARGIN_SCALE);
  }
  return out;
};

/**
 * Look up the card a buy action targets, regardless of source (face-up
 * or own reserve). Returns null if the action isn't a buy or the card
 * isn't found (shouldn't happen for a legal action).
 */
const buyTarget = (state: GameState, action: Action): Card | null => {
  if (action.type !== 'buy') return null;
  if (action.source.kind === 'faceUp') {
    const slot = state.faceUp[action.source.tier][action.source.slot];
    return slot ?? null;
  }
  const player = state.players[state.currentPlayer];
  if (player === undefined) return null;
  const reserved = player.reserved[action.source.index];
  return reserved?.card ?? null;
};

const pickRandom = <T>(items: readonly T[], rng: Rng): T | null => {
  if (items.length === 0) return null;
  const idx = Math.floor(rng() * items.length);
  return items[idx] ?? null;
};

/**
 * Heuristic playout policy. Picks one legal action per call by simple
 * Splendor priority:
 *
 *   1. The highest-prestige affordable buy.
 *   2. Any other affordable buy (these still grant a permanent bonus).
 *   3. Any "take" action (take3 preferred over take2 doesn't matter for the
 *      policy; both go in the same pool).
 *   4. Any reserve.
 *
 * Within each priority tier the action is picked uniformly at random.
 * No `applyTurn` per candidate — fast (~µs per call) and produces
 * Splendor-like trajectories that are far more informative than uniform
 * random play.
 */
const heuristicRolloutAction = (state: GameState, rng: Rng): Action | null => {
  const actions = legalActions(state);
  if (actions.length === 0) return null;

  let maxPrestige = 0;
  for (const a of actions) {
    const card = buyTarget(state, a);
    if (card !== null && card.prestige > maxPrestige) maxPrestige = card.prestige;
  }
  if (maxPrestige > 0) {
    const top: Action[] = [];
    for (const a of actions) {
      const card = buyTarget(state, a);
      if (card !== null && card.prestige === maxPrestige) top.push(a);
    }
    const chosen = pickRandom(top, rng);
    if (chosen !== null) return chosen;
  }

  const buys: Action[] = [];
  for (const a of actions) if (a.type === 'buy') buys.push(a);
  if (buys.length > 0) {
    const chosen = pickRandom(buys, rng);
    if (chosen !== null) return chosen;
  }

  const takes: Action[] = [];
  for (const a of actions) if (a.type === 'take3' || a.type === 'take2') takes.push(a);
  if (takes.length > 0) {
    const chosen = pickRandom(takes, rng);
    if (chosen !== null) return chosen;
  }

  return pickRandom(actions, rng);
};

const pickRolloutAction = (
  state: GameState,
  rng: Rng,
  policy: RolloutPolicy,
): Action | null => {
  if (policy === 'random') {
    return pickRandom(legalActions(state), rng);
  }
  return heuristicRolloutAction(state, rng);
};

const rollout = (
  state: GameState,
  evalFn: Feature,
  maxTurns: number,
  rng: Rng,
  policy: RolloutPolicy,
  pliesFromRoot: number,
  shaping: RewardShaping,
): number[] => {
  let s = state;
  let turns = 0;
  while (!isTerminal(s) && turns < maxTurns) {
    const action = pickRolloutAction(s, rng, policy);
    if (action === null) break;
    s = applyTurn(s, action);
    turns++;
  }
  const n = s.players.length;
  if (isTerminal(s)) {
    const w = winner(s);
    if (shaping === 'discounted') return terminalReward(n, w, pliesFromRoot + turns);
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = i === w ? 1 : 0;
    return out;
  }
  if (shaping === 'discounted') return estimateReward(s, evalFn);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = squash(evalFn(s, i as PlayerIndex));
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

const shuffledArray = <T>(arr: readonly T[], rng: Rng): T[] => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
};

/**
 * Sample a ground-truth state consistent with what `me` can observe in the
 * given state. v1: shuffles the order of cards remaining in each tier's
 * deck. The visible parts of the state — gem supply, face-up cards,
 * prestige, nobles, every player's reserved-card count — are unchanged.
 *
 * NOT yet handled (Phase 3 v2): replacing opponents' blind-reserved card
 * identities with samples from the unknown pool. That fix matters more
 * when the agent's tree explicitly considers "what could the opponent
 * buy from their reserve?"; for the deck-reveal case our current
 * heuristic-rollout MCTS only depends on draw order, which this version
 * randomises correctly.
 */
export const determinize = (state: GameState, rng: Rng): GameState => ({
  ...state,
  decks: {
    1: shuffledArray(state.decks[1], rng),
    2: shuffledArray(state.decks[2], rng),
    3: shuffledArray(state.decks[3], rng),
  },
});

/**
 * Per-candidate MCTS statistics for one root action.
 *
 *   visits     — number of iterations that descended through this action
 *   meanReward — average reward for the *root's active player* under the
 *                subtree rooted at this action. Reward is in [0, 1] where
 *                1 = "active player wins" at terminal leaves and the
 *                squashed evaluator score otherwise.
 */
export type MctsCandidate = {
  action: Action;
  visits: number;
  meanReward: number;
};

/**
 * Output of `mctsBestActionWithStats`. The sum of `winRates` over players
 * is 1.0 for terminal-only rollouts; with non-terminal rollouts using
 * `squash` on the evaluator's score, the sum may diverge slightly from
 * 1.0, so treat the numbers as "directional estimates", not calibrated
 * probabilities.
 */
export type MctsStats = {
  bestAction: Action;
  rootVisits: number;
  /** winRates[i] is the value MCTS assigns to player i from this state. */
  winRates: number[];
  /** Sorted by visits descending. */
  candidates: MctsCandidate[];
};

const finalizeStats = (root: Node): MctsStats => {
  const numPlayers = root.totalReward.length;
  const me = root.currentPlayer;
  // Keep each candidate next to its node so the winRates below come from
  // whichever child we actually recommend, after sorting.
  const ranked: { candidate: MctsCandidate; child: Node }[] = [];
  for (const child of root.children) {
    const action = child.parentAction;
    if (action === null) continue;
    const meanReward = child.visits === 0
      ? 0
      : (child.totalReward[me] ?? 0) / child.visits;
    ranked.push({ candidate: { action, visits: child.visits, meanReward }, child });
  }
  // Most-visited wins, but break ties on mean reward. Visit counts come out
  // exactly equal more often than you would think — UCB1 hands every arm the
  // same budget when their means are indistinguishable — and without the
  // second key we would return whichever action happened to be expanded first.
  ranked.sort((a, b) =>
    (b.candidate.visits - a.candidate.visits)
    || (b.candidate.meanReward - a.candidate.meanReward));
  const candidates = ranked.map((r) => r.candidate);
  const best = candidates[0];
  const bestChild = ranked[0]?.child ?? null;
  if (best === undefined) {
    throw new Error('mctsBestActionWithStats: no expansions performed');
  }
  // Use the best child's per-player average reward as winRates. This answers
  // "given the agent plays the recommended action, what's each player's
  // outcome?" — which is the question a UI pill wants to surface. The root's
  // own totalReward averages across all explored actions (including the
  // sub-optimal ones UCB visited for exploration), so it under-states the
  // leader when one move is decisively winning.
  const winRates = new Array<number>(numPlayers).fill(0);
  const valueSource = bestChild !== null && bestChild.visits > 0 ? bestChild : root;
  if (valueSource.visits > 0) {
    for (let p = 0; p < numPlayers; p++) {
      winRates[p] = (valueSource.totalReward[p] ?? 0) / valueSource.visits;
    }
  }
  return {
    bestAction: best.action,
    rootVisits: root.visits,
    winRates,
    candidates,
  };
};

/**
 * Run MCTS from `rootState` and return rich root statistics: best action,
 * every player's win-rate estimate, and the candidate actions ranked by
 * visit count.
 *
 * Best action is the most-visited root child (not the highest-mean) — when
 * iterations are limited, visit count is a more stable signal.
 */
export const mctsBestActionWithStats = (
  rootState: GameState,
  options: MctsOptions,
): MctsStats => {
  const evalFn = options.evalFn ?? evaluate;
  const rng = options.rng ?? Math.random;
  const c = options.c ?? DEFAULT_C;
  const rolloutDepth = options.rolloutDepth ?? DEFAULT_ROLLOUT_DEPTH;
  const rolloutPolicy = options.rolloutPolicy ?? 'heuristic';
  const rewardShaping = options.rewardShaping ?? 'discounted';
  const determinization = options.determinization ?? false;
  const root = makeNode(rootState, null, null);
  if (root.untriedActions.length === 0) {
    throw new Error('mctsBestActionWithStats: no legal actions at root');
  }

  const deadline = options.timeMs !== undefined ? Date.now() + options.timeMs : undefined;
  const maxIter = options.iterations ?? (deadline === undefined ? 1000 : Number.MAX_SAFE_INTEGER);

  for (let iter = 0; iter < maxIter; iter++) {
    if (deadline !== undefined && Date.now() >= deadline) break;

    let node = root;
    // ISMCTS: each iteration starts from a fresh determinization of the
    // hidden state so the tree's visit statistics average over deck-order
    // uncertainty instead of overfitting to the engine's deterministic
    // top-of-deck reveal.
    let state = determinization ? determinize(rootState, rng) : rootState;

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
    const reward = rollout(
      state, evalFn, rolloutDepth, rng, rolloutPolicy, node.depth, rewardShaping,
    );

    // Backpropagation.
    backpropagate(node, reward);
  }

  return finalizeStats(root);
};

/**
 * Back-compat wrapper — returns only the best action. Existing call sites
 * (agents, search variants) keep working without change.
 */
export const mctsBestAction = (
  rootState: GameState,
  options: MctsOptions,
): Action => mctsBestActionWithStats(rootState, options).bestAction;
