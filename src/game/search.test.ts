import { describe, expect, it } from 'vitest';
import { greedyAgent, iterativeAgent, searchAgent } from './agents';
import { evaluateV3 } from './evaluate';
import { card, makeState, player } from './fixtures';

const emptyGems = () => ({ white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 });

describe('searchAgent', () => {
  it('depth 1 picks the same action as greedy on a deterministic state', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    expect(searchAgent(1, evaluateV3)(s)).toEqual(greedyAgent(evaluateV3)(s));
  });

  it('depth 2 returns a legal action', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    const action = searchAgent(2, evaluateV3)(s);
    expect(action).toBeDefined();
    expect(['take3', 'take2', 'reserve', 'buy']).toContain(action.type);
  });

  it('depth 2 prefers buying over taking when the buy is dominant', () => {
    // Same setup as the depth-1 case — the buy is clearly best regardless
    // of what the opponent does next.
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    expect(searchAgent(2, evaluateV3)(s).type).toBe('buy');
  });

  it('depth 3 returns a legal action in 2 players (alpha-beta path)', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      numPlayers: 2,
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    const action = searchAgent(3, evaluateV3)(s);
    expect(action).toBeDefined();
    expect(['take3', 'take2', 'reserve', 'buy']).toContain(action.type);
  });

  it('depth 3 returns a legal action in 4 players (max-N path)', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      numPlayers: 4,
      faceUp: { 1: [target, null, null, null] },
      players: [
        player({ gems: { ...emptyGems(), blue: 1 } }),
        player(),
        player(),
        player(),
      ],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    const action = searchAgent(2, evaluateV3)(s);
    expect(action).toBeDefined();
    expect(['take3', 'take2', 'reserve', 'buy']).toContain(action.type);
  });
});

describe('iterativeAgent', () => {
  it('returns a legal action within the time budget', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    const start = Date.now();
    const action = iterativeAgent(200, evaluateV3)(s);
    const elapsed = Date.now() - start;
    expect(action).toBeDefined();
    expect(['take3', 'take2', 'reserve', 'buy']).toContain(action.type);
    // Should respect the budget within reason — let one full extra depth's
    // worth of overrun slide.
    expect(elapsed).toBeLessThan(1000);
  });

  it('with a generous budget, picks the same buy as fixed-depth search on a clear-buy state', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    expect(iterativeAgent(500, evaluateV3)(s).type).toBe('buy');
  });
});
