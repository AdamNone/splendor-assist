import { greedyAgent, mctsAgent } from '../game/agents';
import { applyTurn, isTerminal, winner } from '../game/apply';
import { evaluateV3 } from '../game/evaluate';
import { legalActions } from '../game/legalActions';
import { initialState, seededRng } from '../game/setup';
import type { Agent } from '../game/agents';

const agentName = process.argv[2] ?? 'v3';
const games = parseInt(process.argv[3] ?? '100', 10);
const baseSeed = parseInt(process.argv[4] ?? '0', 10);

const make = (rngSeed: number): Agent => {
  switch (agentName) {
    case 'v3':
      return greedyAgent(evaluateV3);
    case 'mcts-200':
      return mctsAgent(200, evaluateV3, seededRng(rngSeed));
    case 'mcts-500':
      return mctsAgent(500, evaluateV3, seededRng(rngSeed));
    default:
      console.error(`Unknown agent: ${agentName}`);
      process.exit(1);
  }
};

// Two independent agent instances so each seat has its own RNG stream when
// the agent is stochastic.
const agent0 = make(baseSeed + 101);
const agent1 = make(baseSeed + 202);

let seat0Wins = 0;
let seat1Wins = 0;
let draws = 0;
let totalTurns = 0;

const start = Date.now();
const setupRng = seededRng(baseSeed + 1);

for (let g = 0; g < games; g++) {
  let s = initialState(2, { rng: setupRng });
  let stalled = false;
  while (!isTerminal(s) && s.turnNumber < 400) {
    if (legalActions(s).length === 0) {
      stalled = true;
      break;
    }
    const agent = s.currentPlayer === 0 ? agent0 : agent1;
    s = applyTurn(s, agent(s));
  }
  totalTurns += s.turnNumber;
  if (stalled || s.turnNumber >= 400) draws += 1;
  else if (winner(s) === 0) seat0Wins += 1;
  else seat1Wins += 1;
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const total = seat0Wins + seat1Wins + draws;
const pct = (n: number) => ((100 * n) / total).toFixed(1);

console.log(`First-mover experiment: ${agentName} vs ${agentName}`);
console.log(`Games: ${games} (seed ${baseSeed}, no seat alternation)\n`);
console.log(`  Seat 0 (first)  wins: ${seat0Wins} (${pct(seat0Wins)}%)`);
console.log(`  Seat 1 (second) wins: ${seat1Wins} (${pct(seat1Wins)}%)`);
console.log(`  Draws               : ${draws} (${pct(draws)}%)`);
console.log(
  `\nFirst-mover advantage: ${seat0Wins - seat1Wins} games ` +
    `(${(100 * (seat0Wins - seat1Wins) / total).toFixed(1)} pp).`,
);
console.log(`avg turns/game: ${(totalTurns / total).toFixed(1)}`);
console.log(`elapsed       : ${elapsed}s`);
