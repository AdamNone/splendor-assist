import { greedyAgent, randomAgent } from '../game/agents';
import { applyTurn, isTerminal, winner } from '../game/apply';
import { evaluateBaseline, evaluateV2 } from '../game/evaluate';
import { legalActions } from '../game/legalActions';
import { formatGameEnd, formatPlayer, narrate } from '../game/narrate';
import { initialState, seededRng } from '../game/setup';
import { playMatch } from '../game/tournament';
import type { Agent } from '../game/agents';
import type { Feature } from '../game/evaluate';

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

const EVALUATORS: Record<string, Feature> = {
  baseline: evaluateBaseline,
  v2: evaluateV2,
};

const compare = (
  games: number,
  seed: number,
  aName: string,
  bName: string,
): void => {
  const aEval = EVALUATORS[aName];
  const bEval = EVALUATORS[bName];
  if (aEval === undefined || bEval === undefined) {
    console.error(`Unknown evaluator. Choose from: ${Object.keys(EVALUATORS).join(', ')}`);
    process.exit(1);
  }
  console.log(`A/B: greedy(${aName}) vs greedy(${bName}) | ${games} games | seed=${seed}\n`);
  const start = Date.now();
  const result = playMatch(greedyAgent(aEval), greedyAgent(bEval), {
    games,
    rng: seededRng(seed),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const total = result.aWins + result.bWins + result.draws;
  const pct = (n: number) => ((100 * n) / total).toFixed(1);
  console.log(`${aName.padEnd(10)} wins: ${result.aWins} (${pct(result.aWins)}%)`);
  console.log(`${bName.padEnd(10)} wins: ${result.bWins} (${pct(result.bWins)}%)`);
  console.log(`draws         : ${result.draws} (${pct(result.draws)}%)`);
  console.log(`avg turns/game: ${(result.totalTurns / total).toFixed(1)}`);
  console.log(`elapsed       : ${elapsed}s`);
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
  const aName = args[3] ?? 'v2';
  const bName = args[4] ?? 'baseline';
  compare(games, seed, aName, bName);
} else {
  const seed = intArg(args[1], 42);
  const numPlayers = (intArg(args[2], 2) as 2 | 3 | 4);
  playOneGame(seed, numPlayers);
}
