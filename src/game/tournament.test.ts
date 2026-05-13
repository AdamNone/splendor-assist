import { describe, expect, it } from 'vitest';
import { greedyAgent, mctsAgent, randomAgent, searchAgent } from './agents';
import { evaluateBaseline, evaluateV2, evaluateV3 } from './evaluate';
import { seededRng } from './setup';
import { playMatch } from './tournament';

describe('playMatch', () => {
  it('runs games and reports counts that sum correctly', async () => {
    const result = await playMatch(
      randomAgent(seededRng(1)),
      randomAgent(seededRng(2)),
      { games: 4, rng: seededRng(123) },
    );
    expect(result.aWins + result.bWins + result.draws).toBe(4);
  });

  it('descriptor-mode (parallel) returns sane counts', async () => {
    // Use descriptors to force the parallel/worker path. We don't compare
    // game-for-game against the sequential function-based path because the
    // two have different agent lifecycles by design (workers can't share
    // function-closure state across games, so descriptors get a fresh agent
    // per game; function agents are reused across games).
    const result = await playMatch(
      { name: 'random', seed: 1 },
      { name: 'random', seed: 2 },
      { games: 8, rng: seededRng(999) },
    );
    expect(result.aWins + result.bWins + result.draws).toBe(8);
    expect(result.totalTurns).toBeGreaterThan(0);
  }, 60_000);
});

describe('experiment: greedy vs random', () => {
  // The point of this test is to confirm the baseline evaluator is doing
  // *something*. If greedy can't beat random with the same engine and rules,
  // we have a bug. We require >70% to allow some variance from RNG.
  it('greedy beats random in at least 7 of 10 games', async () => {
    const result = await playMatch(greedyAgent(), randomAgent(seededRng(7)), {
      games: 10,
      rng: seededRng(42),
    });
    const winRate = result.aWins / (result.aWins + result.bWins + result.draws);
    expect(winRate).toBeGreaterThanOrEqual(0.7);
  }, 60_000);
});

describe('experiment: v2 (with noble proximity) vs baseline', () => {
  it('v2 wins at least as many head-to-head games as baseline', async () => {
    const result = await playMatch(
      greedyAgent(evaluateV2),
      greedyAgent(evaluateBaseline),
      { games: 12, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 60_000);
});

describe('experiment: v3 (with opponent_threat) vs v2', () => {
  it('v3 wins at least as many head-to-head games as v2', async () => {
    const result = await playMatch(
      greedyAgent(evaluateV3),
      greedyAgent(evaluateV2),
      { games: 12, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 60_000);
});

describe('experiment: search depth-2 (max-N) vs greedy(v3)', () => {
  it('search-d2 wins at least as many head-to-head games as greedy(v3)', async () => {
    const result = await playMatch(
      searchAgent(2, evaluateV3),
      greedyAgent(evaluateV3),
      { games: 6, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 120_000);
});

describe('experiment: search depth-3 (alpha-beta) vs greedy(v3)', () => {
  it('search-d3 wins at least as many head-to-head games as greedy(v3)', async () => {
    const result = await playMatch(
      searchAgent(3, evaluateV3),
      greedyAgent(evaluateV3),
      { games: 4, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 180_000);
});

describe('experiment: mcts (200 iter) vs random', () => {
  it('mcts-200 wins at least as many head-to-head games as random', async () => {
    const result = await playMatch(
      mctsAgent(200, evaluateV3, seededRng(101)),
      randomAgent(seededRng(7)),
      { games: 4, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 180_000);
});
