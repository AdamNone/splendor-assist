import {
  greedyAgent,
  iterativeAgent,
  mctsAgent,
  mctsTimeAgent,
  randomAgent,
  searchAgent,
} from './agents';
import type { Agent } from './agents';
import {
  evaluateBaseline,
  evaluateV2,
  evaluateV3,
  evaluateV4,
  evaluateV3PlusConc,
  evaluateV3PlusEngine,
  evaluateV3PlusPressure,
} from './evaluate';
import { seededRng } from './setup';

/**
 * A serializable description of an agent. Used by the parallel tournament
 * harness — workers reconstruct agents from descriptors via `makeAgent`.
 *
 * `seed` is required for stochastic agents (random, MCTS). Deterministic
 * agents (greedy / search variants) ignore it.
 */
export type AgentDescriptor = { name: string; seed?: number };

export const ALL_AGENT_NAMES = [
  'random',
  'baseline',
  'v2',
  'v3',
  'v4',
  'search-d2',
  'search-d3',
  'search-d4',
  'search-d3-conc',
  'search-d3-engine',
  'search-d3-pressure',
  'iter-100',
  'iter-300',
  'iter-1000',
  'mcts-200',
  'mcts-500',
  'mcts-1000',
  'mcts-2000',
  'mcts-500ms',
  'mcts-1s',
  'mcts-3s',
  'mcts-1s-rand',
  'mcts-500ms-rand',
  'ismcts-200',
  'ismcts-500',
  'ismcts-1000',
  'ismcts-500ms',
  'ismcts-1s',
] as const;

export type AgentName = (typeof ALL_AGENT_NAMES)[number];

/**
 * Construct an agent from a name + optional seed. Seeded agents (random,
 * MCTS) take the seed; deterministic agents ignore it.
 *
 * Returns null for unknown names so callers can surface a useful error.
 */
export const makeAgent = (name: string, seed: number = 0): Agent | null => {
  const rng = seededRng(seed);
  switch (name) {
    case 'random':
      return randomAgent(rng);
    case 'baseline':
      return greedyAgent(evaluateBaseline);
    case 'v2':
      return greedyAgent(evaluateV2);
    case 'v3':
      return greedyAgent(evaluateV3);
    case 'v4':
      return greedyAgent(evaluateV4);
    case 'search-d2':
      return searchAgent(2, evaluateV3);
    case 'search-d3':
      return searchAgent(3, evaluateV3);
    case 'search-d4':
      return searchAgent(4, evaluateV3);
    case 'search-d3-conc':
      return searchAgent(3, evaluateV3PlusConc);
    case 'search-d3-engine':
      return searchAgent(3, evaluateV3PlusEngine);
    case 'search-d3-pressure':
      return searchAgent(3, evaluateV3PlusPressure);
    case 'iter-100':
      return iterativeAgent(100, evaluateV3);
    case 'iter-300':
      return iterativeAgent(300, evaluateV3);
    case 'iter-1000':
      return iterativeAgent(1000, evaluateV3);
    case 'mcts-200':
      return mctsAgent(200, evaluateV3, rng);
    case 'mcts-500':
      return mctsAgent(500, evaluateV3, rng);
    case 'mcts-1000':
      return mctsAgent(1000, evaluateV3, rng);
    case 'mcts-2000':
      return mctsAgent(2000, evaluateV3, rng);
    case 'mcts-500ms':
      return mctsTimeAgent(500, evaluateV3, rng);
    case 'mcts-1s':
      return mctsTimeAgent(1000, evaluateV3, rng);
    case 'mcts-3s':
      return mctsTimeAgent(3000, evaluateV3, rng);
    case 'mcts-1s-rand':
      return mctsTimeAgent(1000, evaluateV3, rng, 'random');
    case 'mcts-500ms-rand':
      return mctsTimeAgent(500, evaluateV3, rng, 'random');
    // ISMCTS variants — deck-shuffle determinization per iteration.
    case 'ismcts-200':
      return mctsAgent(200, evaluateV3, rng, 'heuristic', true);
    case 'ismcts-500':
      return mctsAgent(500, evaluateV3, rng, 'heuristic', true);
    case 'ismcts-1000':
      return mctsAgent(1000, evaluateV3, rng, 'heuristic', true);
    case 'ismcts-500ms':
      return mctsTimeAgent(500, evaluateV3, rng, 'heuristic', true);
    case 'ismcts-1s':
      return mctsTimeAgent(1000, evaluateV3, rng, 'heuristic', true);
    default:
      return null;
  }
};

export const isAgentDescriptor = (x: unknown): x is AgentDescriptor =>
  typeof x === 'object' &&
  x !== null &&
  'name' in x &&
  typeof (x as { name: unknown }).name === 'string';
