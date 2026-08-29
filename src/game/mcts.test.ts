import { describe, expect, it } from 'vitest';
import { mctsAgent } from './agents';
import { evaluateV3 } from './evaluate';
import { card, makeState, player } from './fixtures';
import { mctsBestActionWithStats } from './mcts';
import { seededRng } from './setup';

const emptyGems = () => ({ white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 });

describe('mctsAgent', () => {
  it('returns a legal action', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    const action = mctsAgent(200, evaluateV3, seededRng(1))(s);
    expect(action).toBeDefined();
    expect(['take3', 'take2', 'reserve', 'buy']).toContain(action.type);
  });

  it('prefers a clearly-winning buy over takes given enough iterations', () => {
    // Player can afford a card worth +1 prestige; greedy already prefers it,
    // and MCTS should too once it has enough iterations to differentiate.
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    const action = mctsAgent(500, evaluateV3, seededRng(7))(s);
    expect(action.type).toBe('buy');
  });

  it('is deterministic given the same RNG seed', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    const a = mctsAgent(200, evaluateV3, seededRng(42))(s);
    const b = mctsAgent(200, evaluateV3, seededRng(42))(s);
    expect(a).toEqual(b);
  });
});

describe('reward shaping', () => {
  /**
   * A position where the mover is at 14 prestige and several moves all lead
   * to a win: buying the 1-prestige card ends it on this turn, while taking
   * gems (or buying the 0-prestige card) still wins a round later, because
   * the rollout policy buys the prestige card next turn anyway.
   *
   * Under 1/0 terminal rewards every one of those moves scores exactly 1.0,
   * the search sees a tie and returns whatever it expanded first. This is the
   * shape of the bug that let a +7 prestige buy sit unplayed for two turns in
   * a real logged game.
   */
  const winNowState = () => {
    const winning = card('WIN', 1, 'red', 1, { blue: 1 });
    const idle = card('IDLE', 1, 'green', 0, { blue: 1 });
    return makeState({
      faceUp: { 1: [winning, idle, null, null] },
      players: [
        player({ gems: { white: 0, blue: 1, green: 0, red: 0, black: 0, gold: 0 }, prestige: 14 }),
        player(),
      ],
      gemSupply: { white: 4, blue: 4, green: 4, red: 4, black: 4 },
      turnNumber: 1,
    });
  };

  it('prefers the move that wins now over slower moves that also win', () => {
    const stats = mctsBestActionWithStats(winNowState(), {
      iterations: 800,
      evalFn: evaluateV3,
      rng: seededRng(3),
    });
    expect(stats.bestAction).toMatchObject({
      type: 'buy',
      source: { kind: 'faceUp', tier: 1, slot: 0 },
    });
  });

  it('scores the winning buy strictly above every other move', () => {
    // Symmetric moves (take3 of one colour set vs another) may legitimately
    // tie; what must not happen is the winning move tying with anything.
    const stats = mctsBestActionWithStats(winNowState(), {
      iterations: 800,
      evalFn: evaluateV3,
      rng: seededRng(3),
    });
    const [top, ...rest] = stats.candidates;
    expect(top).toBeDefined();
    for (const c of rest) expect(c.meanReward).toBeLessThan(top!.meanReward);
  });

  it('binary shaping is still available and does tie', () => {
    const stats = mctsBestActionWithStats(winNowState(), {
      iterations: 800,
      evalFn: evaluateV3,
      rng: seededRng(3),
      rewardShaping: 'binary',
    });
    // Documents why the default changed: several distinct moves, one score.
    const perfect = stats.candidates.filter((c) => c.meanReward === 1);
    expect(perfect.length).toBeGreaterThan(1);
  });
});
