import {
  greedyAgent,
  iterativeAgent,
  mctsAgent,
  mctsTimeAgent,
  randomAgent,
  searchAgent,
} from '../game/agents';
import { applyTurn, isTerminal, winner } from '../game/apply';
import {
  evaluateBaseline,
  evaluateV2,
  evaluateV3,
  evaluateV3PlusConc,
  evaluateV3PlusEngine,
  evaluateV3PlusPressure,
} from '../game/evaluate';
import { legalActions } from '../game/legalActions';
import { formatGameEnd, formatPlayer, narrate } from '../game/narrate';
import { initialState, seededRng } from '../game/setup';
import { playMatch } from '../game/tournament';
import type { Agent } from '../game/agents';
import type { Rng } from '../game/setup';

const args = process.argv.slice(2);
const mode = args[0] ?? 'play';

const intArg = (s: string | undefined, fallback: number): number => {
  if (s === undefined) return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
};

const playOneGame = (seed: number, numPlayers: 2 | 3 | 4): void => {
  console.log(
    `Splendor self-play: greedy (P0) vs random (P1+) | seed=${seed} | players=${numPlayers}\n`,
  );

  let s = initialState(numPlayers, { rng: seededRng(seed) });
  const greedy: Agent = greedyAgent();
  const random: Agent = randomAgent(seededRng(seed + 1));

  while (!isTerminal(s) && s.turnNumber < 400) {
    if (legalActions(s).length === 0) {
      console.log(`T${s.turnNumber} P${s.currentPlayer} has no legal actions; stopping.`);
      break;
    }
    const agent = s.currentPlayer === 0 ? greedy : random;
    const action = agent(s);
    console.log(narrate(s, action));
    s = applyTurn(s, action);
  }

  console.log('');
  if (isTerminal(s)) {
    console.log(formatGameEnd(s, winner(s)));
  } else {
    console.log(`Game stopped at turn ${s.turnNumber}.`);
    for (let i = 0; i < numPlayers; i++) {
      console.log('  ' + formatPlayer(s, i));
    }
  }
};

const playTournament = (games: number, seed: number): void => {
  console.log(`Tournament: greedy vs random | ${games} games | seed=${seed}\n`);
  const start = Date.now();
  const result = playMatch(greedyAgent(), randomAgent(seededRng(seed + 1)), {
    games,
    rng: seededRng(seed),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const total = result.aWins + result.bWins + result.draws;
  const pct = (n: number) => ((100 * n) / total).toFixed(1);
  console.log(`greedy   wins: ${result.aWins} (${pct(result.aWins)}%)`);
  console.log(`random   wins: ${result.bWins} (${pct(result.bWins)}%)`);
  console.log(`draws         : ${result.draws} (${pct(result.draws)}%)`);
  console.log(`avg turns/game: ${(result.totalTurns / total).toFixed(1)}`);
  console.log(`elapsed       : ${elapsed}s`);
};

/**
 * Map a CLI-friendly name to an agent factory. The factory takes an rng
 * (used by random) and returns a fresh agent. Search agents are
 * deterministic so they ignore the rng.
 */
const makeAgent = (name: string, agentRng: Rng): Agent | null => {
  switch (name) {
    case 'random': return randomAgent(agentRng);
    case 'baseline': return greedyAgent(evaluateBaseline);
    case 'v2': return greedyAgent(evaluateV2);
    case 'v3': return greedyAgent(evaluateV3);
    case 'search-d2': return searchAgent(2, evaluateV3);
    case 'search-d3': return searchAgent(3, evaluateV3);
    case 'search-d4': return searchAgent(4, evaluateV3);
    case 'search-d3-conc': return searchAgent(3, evaluateV3PlusConc);
    case 'search-d3-engine': return searchAgent(3, evaluateV3PlusEngine);
    case 'search-d3-pressure': return searchAgent(3, evaluateV3PlusPressure);
    case 'iter-100': return iterativeAgent(100, evaluateV3);
    case 'iter-300': return iterativeAgent(300, evaluateV3);
    case 'iter-1000': return iterativeAgent(1000, evaluateV3);
    case 'mcts-200': return mctsAgent(200, evaluateV3, agentRng);
    case 'mcts-500': return mctsAgent(500, evaluateV3, agentRng);
    case 'mcts-1000': return mctsAgent(1000, evaluateV3, agentRng);
    case 'mcts-2000': return mctsAgent(2000, evaluateV3, agentRng);
    case 'mcts-500ms': return mctsTimeAgent(500, evaluateV3, agentRng);
    case 'mcts-1s': return mctsTimeAgent(1000, evaluateV3, agentRng);
    case 'mcts-3s': return mctsTimeAgent(3000, evaluateV3, agentRng);
    // 'rand' variants force the legacy random rollout policy for A/B vs heuristic.
    case 'mcts-1s-rand': return mctsTimeAgent(1000, evaluateV3, agentRng, 'random');
    case 'mcts-500ms-rand': return mctsTimeAgent(500, evaluateV3, agentRng, 'random');
    default: return null;
  }
};

const AGENT_NAMES = [
  'random', 'baseline', 'v2', 'v3',
  'search-d2', 'search-d3', 'search-d4',
  'search-d3-conc', 'search-d3-engine', 'search-d3-pressure',
  'iter-100', 'iter-300', 'iter-1000',
  'mcts-200', 'mcts-500', 'mcts-1000', 'mcts-2000',
  'mcts-500ms', 'mcts-1s', 'mcts-3s',
  'mcts-1s-rand', 'mcts-500ms-rand',
];

const compare = (
  games: number,
  seed: number,
  aName: string,
  bName: string,
): void => {
  const a = makeAgent(aName, seededRng(seed + 1001));
  const b = makeAgent(bName, seededRng(seed + 2002));
  if (a === null || b === null) {
    console.error(`Unknown agent. Choose from: ${AGENT_NAMES.join(', ')}`);
    process.exit(1);
  }
  console.log(`A/B: ${aName} vs ${bName} | ${games} games | seed=${seed}\n`);
  const start = Date.now();
  const result = playMatch(a, b, {
    games,
    rng: seededRng(seed),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const total = result.aWins + result.bWins + result.draws;
  const pct = (n: number) => ((100 * n) / total).toFixed(1);
  console.log(`${aName.padEnd(11)} wins: ${result.aWins} (${pct(result.aWins)}%)`);
  console.log(`${bName.padEnd(11)} wins: ${result.bWins} (${pct(result.bWins)}%)`);
  console.log(`draws          : ${result.draws} (${pct(result.draws)}%)`);
  console.log(`avg turns/game : ${(result.totalTurns / total).toFixed(1)}`);
  console.log(`elapsed        : ${elapsed}s`);
  console.log(
    `\n${aName} advantage: ${(result.aWins - result.bWins).toString()} games (` +
      `${(100 * (result.aWins - result.bWins) / total).toFixed(1)} pp).`,
  );
};

if (mode === 'match') {
  const games = intArg(args[1], 30);
  const seed = intArg(args[2], 42);
  playTournament(games, seed);
} else if (mode === 'compare') {
  const games = intArg(args[1], 30);
  const seed = intArg(args[2], 42);
  const aName = args[3] ?? 'search-d2';
  const bName = args[4] ?? 'v3';
  compare(games, seed, aName, bName);
} else {
  const seed = intArg(args[1], 42);
  const numPlayers = (intArg(args[2], 2) as 2 | 3 | 4);
  playOneGame(seed, numPlayers);
}
