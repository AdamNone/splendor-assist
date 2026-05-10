import { describe, expect, it } from 'vitest';
import { legalActions } from './legalActions';
import { card, makeState, player } from './fixtures';

describe('legalActions: take3', () => {
  it('enumerates all 3-color subsets when ≥3 colors available', () => {
    const state = makeState({
      gemSupply: { white: 1, blue: 1, green: 1, red: 1, black: 1 },
    });
    const take3s = legalActions(state).filter((a) => a.type === 'take3');
    expect(take3s).toHaveLength(10); // C(5,3)
    for (const a of take3s) {
      if (a.type === 'take3') expect(a.colors).toHaveLength(3);
    }
  });

  it('falls back to k = 2 when only 2 colors are available', () => {
    const state = makeState({ gemSupply: { white: 1, red: 1 } });
    const take3s = legalActions(state).filter((a) => a.type === 'take3');
    expect(take3s).toHaveLength(1);
    if (take3s[0]?.type === 'take3') {
      expect(take3s[0].colors.sort()).toEqual(['red', 'white']);
    }
  });

  it('emits no take3 when no colored gems are in supply', () => {
    const state = makeState({ gemSupply: { gold: 5 } });
    expect(legalActions(state).filter((a) => a.type === 'take3')).toHaveLength(0);
  });
});

describe('legalActions: take2', () => {
  it('only legal when pile has ≥4', () => {
    const state = makeState({
      gemSupply: { white: 4, blue: 3, green: 5, red: 0 },
    });
    const take2s = legalActions(state).filter((a) => a.type === 'take2');
    const colors = take2s.flatMap((a) => (a.type === 'take2' ? [a.color] : []));
    expect(colors.sort()).toEqual(['green', 'white']);
  });

  it('does not allow take2 on gold (gold is reserve-only)', () => {
    const state = makeState({ gemSupply: { gold: 5 } });
    expect(legalActions(state).filter((a) => a.type === 'take2')).toHaveLength(0);
  });
});

describe('legalActions: reserve', () => {
  it('blocked when player already has 3 reserved', () => {
    const c = card('T1-001', 1, 'white', 0, { blue: 1 });
    const p = player({ reserved: [c, c, c] });
    const state = makeState({
      players: [p, player()],
      faceUp: { 1: [c, null, null, null] },
      decks: { 1: [c] },
    });
    expect(legalActions(state).filter((a) => a.type === 'reserve')).toHaveLength(0);
  });

  it('emits one reserve per visible face-up card and one per non-empty deck', () => {
    const c = card('T1-001', 1, 'white', 0, { blue: 1 });
    const state = makeState({
      faceUp: {
        1: [c, c, null, null],
        2: [c, null, null, null],
      },
      decks: { 1: [c, c], 3: [c] },
    });
    const reserves = legalActions(state).filter((a) => a.type === 'reserve');
    // 2 face-up tier 1 + 1 face-up tier 2 + deck-tops for tiers 1 and 3 = 5
    expect(reserves).toHaveLength(5);
  });
});

describe('legalActions: buy', () => {
  it('cannot buy what the player cannot afford', () => {
    const expensive = card('T3-001', 3, 'red', 5, { white: 7 });
    const state = makeState({
      players: [player({ gems: { ...emptyGems(), white: 2 } }), player()],
      faceUp: { 3: [expensive, null, null, null] },
    });
    expect(legalActions(state).filter((a) => a.type === 'buy')).toHaveLength(0);
  });

  it('can buy when colored gems cover the cost exactly', () => {
    const cheap = card('T1-001', 1, 'white', 0, { blue: 2 });
    const state = makeState({
      players: [player({ gems: { ...emptyGems(), blue: 2 } }), player()],
      faceUp: { 1: [cheap, null, null, null] },
    });
    const buys = legalActions(state).filter((a) => a.type === 'buy');
    expect(buys).toHaveLength(1);
    if (buys[0]?.type === 'buy') {
      expect(buys[0].payment.blue).toBe(2);
      expect(buys[0].payment.gold).toBe(0);
    }
  });

  it('uses bonuses as discounts before colored gems', () => {
    const blueCard = card('T1-001', 1, 'blue', 0, {});
    const target = card('T1-002', 1, 'red', 0, { blue: 2 });
    const state = makeState({
      players: [
        player({ purchased: [blueCard, blueCard], gems: emptyGems() }),
        player(),
      ],
      faceUp: { 1: [target, null, null, null] },
    });
    const buys = legalActions(state).filter((a) => a.type === 'buy');
    expect(buys).toHaveLength(1);
    if (buys[0]?.type === 'buy') {
      expect(buys[0].payment.blue).toBe(0);
      expect(buys[0].payment.gold).toBe(0);
    }
  });

  it('uses gold to cover the shortfall', () => {
    const target = card('T1-001', 1, 'red', 0, { blue: 3 });
    const state = makeState({
      players: [
        player({ gems: { ...emptyGems(), blue: 1, gold: 2 } }),
        player(),
      ],
      faceUp: { 1: [target, null, null, null] },
    });
    const buys = legalActions(state).filter((a) => a.type === 'buy');
    expect(buys).toHaveLength(1);
    if (buys[0]?.type === 'buy') {
      expect(buys[0].payment.blue).toBe(1);
      expect(buys[0].payment.gold).toBe(2);
    }
  });

  it('can buy from own reserve', () => {
    const cheap = card('T1-001', 1, 'white', 0, { blue: 1 });
    const state = makeState({
      players: [
        player({ reserved: [cheap], gems: { ...emptyGems(), blue: 1 } }),
        player(),
      ],
    });
    const buys = legalActions(state).filter((a) => a.type === 'buy');
    expect(buys).toHaveLength(1);
    if (buys[0]?.type === 'buy' && buys[0].source.kind === 'reserve') {
      expect(buys[0].source.index).toBe(0);
    }
  });
});

const emptyGems = () => ({ white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 });
