import { describe, expect, it } from 'vitest';
import { greedyAgent, mctsAgent, randomAgent, searchAgent } from './agents';
import { evaluateBaseline, evaluateV2, evaluateV3 } from './evaluate';
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

describe('experiment: v3 (with opponent_threat) vs v2', () => {
  // 50-game spot-checks at seeds 7 / 11 / 23 show v3 wins by +16 / +16 / +22 pp.
  // Conservative bar: v3 must win at least as many as v2.
  it('v3 wins at least as many head-to-head games as v2', () => {
    const result = playMatch(
      greedyAgent(evaluateV3),
      greedyAgent(evaluateV2),
      { games: 12, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 60_000);
});

describe('experiment: search depth-2 (max-N) vs greedy(v3)', () => {
  // 20-game spot-checks at seeds 7 / 11 / 23 show max-N depth 2 wins by
  // +25 / +15 / +30 pp. This regression test runs fewer games (search is
  // ~75ms/turn) with a conservative bar.
  it('search-d2 wins at least as many head-to-head games as greedy(v3)', () => {
    const result = playMatch(
      searchAgent(2, evaluateV3),
      greedyAgent(evaluateV3),
      { games: 6, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 120_000);
});

describe('experiment: search depth-3 (alpha-beta) vs greedy(v3)', () => {
  // 12-game spot-checks at seeds 7 / 11 / 23 show alpha-beta depth 3 wins
  // by +33 / +67 / +33 pp (avg +44). The dispatcher routes 2-player depth-3
  // searches through alpha-beta because the pruning makes that depth
  // tractable (~200 ms/turn). Bar is conservative.
  it('search-d3 wins at least as many head-to-head games as greedy(v3)', () => {
    const result = playMatch(
      searchAgent(3, evaluateV3),
      greedyAgent(evaluateV3),
      { games: 4, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 180_000);
});

describe('experiment: mcts (200 iter) vs random', () => {
  // mcts-1s beats search-d3 by +44 pp (Experiment 11); spot checks show
  // mcts-500 beats greedy(v3) by ~+33 pp. This regression test uses a
  // smaller budget (200 iter) against random — MCTS at any reasonable
  // budget must crush a random opponent, so this only catches outright
  // regressions in the MCTS machinery.
  it('mcts-200 wins at least as many head-to-head games as random', () => {
    const result = playMatch(
      mctsAgent(200, evaluateV3, seededRng(101)),
      randomAgent(seededRng(7)),
      { games: 4, rng: seededRng(42) },
    );
    expect(result.aWins).toBeGreaterThanOrEqual(result.bWins);
  }, 180_000);
});
