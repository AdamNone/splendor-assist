import { describe, expect, it } from 'vitest';
import { greedyAgent, randomAgent } from './agents';
import { evaluateBaseline, evaluateV2 } from './evaluate';
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

describe('experiment: v2 (with noble proximity) vs baseline', () => {
  // Noble proximity is the first feature added on top of the baseline. The
  // hypothesis is "greedy currently has no signal for nobles until they're
  // literally claimed; adding proximity should give it 7+ turns of foresight."
  // 50-game spot-check shows v2 wins 26 vs baseline 16 (+20pp). The test
  // below uses fewer games and a much weaker bar so RNG variance doesn't
  // flake — but if v2 ever drops *below* baseline, that's a regression we
  // want to catch.
  it('v2 wins at least as many head-to-head games as baseline', () => {
    const result = playMatch(
      greedyAgent(evaluateV2),
      greedyAgent(evaluateBaseline),
      { games: 12, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 60_000);
});
