import { describe, expect, it } from 'vitest';
import { greedyAgent, randomAgent } from './agents';
import { seededRng } from './setup';
import { playMatch } from './tournament';

describe('playMatch', () => {
  it('runs games and reports counts that sum correctly', () => {
    const result = playMatch(randomAgent(seededRng(1)), randomAgent(seededRng(2)), {
      games: 4,
      rng: seededRng(123),
    });
    expect(result.aWins + result.bWins + result.draws).toBe(4);
  });
});

describe('experiment: greedy vs random', () => {
  // The point of this test is to confirm the baseline evaluator is doing
  // *something*. If greedy can't beat random with the same engine and rules,
  // we have a bug. We require >70% to allow some variance from RNG.
  it('greedy beats random in at least 7 of 10 games', () => {
    const result = playMatch(greedyAgent(), randomAgent(seededRng(7)), {
      games: 10,
      rng: seededRng(42),
    });
    const winRate = result.aWins / (result.aWins + result.bWins + result.draws);
    expect(winRate).toBeGreaterThanOrEqual(0.7);
  }, 60_000);
});
