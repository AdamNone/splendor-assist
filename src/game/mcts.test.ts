import { describe, expect, it } from 'vitest';
import { mctsAgent } from './agents';
import { evaluateV3 } from './evaluate';
import { card, makeState, player } from './fixtures';
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
