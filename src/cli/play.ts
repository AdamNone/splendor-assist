import { greedyAgent, randomAgent } from '../game/agents';
import { ALL_AGENT_NAMES, makeAgent } from '../game/agentFactory';
import { applyTurn, isTerminal, winner } from '../game/apply';
import { legalActions } from '../game/legalActions';
import { formatGameEnd, formatPlayer, narrate } from '../game/narrate';
import { initialState, seededRng } from '../game/setup';
import { playMatch } from '../game/tournament';
import type { Agent } from '../game/agents';

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

const playTournament = async (games: number, seed: number): Promise<void> => {
  console.log(`Tournament: greedy vs random | ${games} games | seed=${seed}\n`);
  const start = Date.now();
  const result = await playMatch(
    { name: 'v3' },
    { name: 'random', seed: seed + 1 },
    { games, rng: seededRng(seed) },
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const total = result.aWins + result.bWins + result.draws;
  const pct = (n: number) => ((100 * n) / total).toFixed(1);
  console.log(`greedy   wins: ${result.aWins} (${pct(result.aWins)}%)`);
  console.log(`random   wins: ${result.bWins} (${pct(result.bWins)}%)`);
  console.log(`draws         : ${result.draws} (${pct(result.draws)}%)`);
  console.log(`avg turns/game: ${(result.totalTurns / total).toFixed(1)}`);
  console.log(`elapsed       : ${elapsed}s`);
};

const compare = async (
  games: number,
  seed: number,
  aName: string,
  bName: string,
  numPlayers: 2 | 3 | 4 = 2,
): Promise<void> => {
  // Sanity-check the names against the factory before dispatching to workers.
  if (makeAgent(aName, 0) === null || makeAgent(bName, 0) === null) {
    console.error(`Unknown agent. Choose from: ${ALL_AGENT_NAMES.join(', ')}`);
    process.exit(1);
  }
  console.log(`A/B: ${aName} vs ${bName} | ${games} games | seed=${seed} | ${numPlayers}P\n`);
  const start = Date.now();
  const result = await playMatch(
    { name: aName, seed: seed + 1001 },
    { name: bName, seed: seed + 2002 },
    { games, rng: seededRng(seed), numPlayers },
  );
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

const main = async (): Promise<void> => {
  if (mode === 'match') {
    const games = intArg(args[1], 30);
    const seed = intArg(args[2], 42);
    await playTournament(games, seed);
  } else if (mode === 'compare') {
    const games = intArg(args[1], 30);
    const seed = intArg(args[2], 42);
    const aName = args[3] ?? 'search-d2';
    const bName = args[4] ?? 'v3';
    const numPlayers = (intArg(args[5], 2) as 2 | 3 | 4);
    await compare(games, seed, aName, bName, numPlayers);
  } else {
    const seed = intArg(args[1], 42);
    const numPlayers = (intArg(args[2], 2) as 2 | 3 | 4);
    playOneGame(seed, numPlayers);
  }
};

void main();
