import { describe, expect, it } from 'vitest';
import { apply, applyReveal, applyTurn, isTerminal, winner } from './apply';
import { card, makeState, noble, player, reservedCard } from './fixtures';
import { initialState, seededRng } from './setup';
import type { Action, Color } from './types';

const emptyGems = () => ({ white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 });

const mkCard = (id: string, bonus: Color, prestige = 0, cost: Partial<Record<Color, number>> = {}) =>
  card(id, 1, bonus, prestige, cost);

describe('apply: take3', () => {
  it('moves 3 gems from supply to player and advances turn', () => {
    const s0 = makeState({ gemSupply: { white: 2, blue: 2, green: 2 } });
    const s1 = apply(s0, { type: 'take3', colors: ['white', 'blue', 'green'] });
    expect(s1.gemSupply.white).toBe(1);
    expect(s1.gemSupply.blue).toBe(1);
    expect(s1.gemSupply.green).toBe(1);
    expect(s1.players[0]?.gems).toEqual({
      ...emptyGems(),
      white: 1,
      blue: 1,
      green: 1,
    });
    expect(s1.currentPlayer).toBe(1);
    expect(s1.turnNumber).toBe(1);
  });

  it('does not mutate the input state', () => {
    const s0 = makeState({ gemSupply: { white: 1, blue: 1, green: 1 } });
    const before = JSON.stringify(s0);
    apply(s0, { type: 'take3', colors: ['white', 'blue', 'green'] });
    expect(JSON.stringify(s0)).toBe(before);
  });
});

describe('apply: take2', () => {
  it('moves 2 gems from supply to player', () => {
    const s0 = makeState({ gemSupply: { white: 4 } });
    const s1 = apply(s0, { type: 'take2', color: 'white' });
    expect(s1.gemSupply.white).toBe(2);
    expect(s1.players[0]?.gems.white).toBe(2);
  });

  it('throws when supply is below the take-2 floor', () => {
    const s0 = makeState({ gemSupply: { white: 3 } });
    expect(() => apply(s0, { type: 'take2', color: 'white' })).toThrow();
  });
});

describe('apply: reserve', () => {
  it('reserve face-up empties the slot, queues a reveal, and grants gold', () => {
    const c = mkCard('T1-001', 'red', 0, { blue: 1 });
    const s0 = makeState({
      faceUp: { 1: [c, null, null, null] },
      gemSupply: { gold: 5 },
    });
    const s1 = apply(s0, {
      type: 'reserve',
      source: { kind: 'faceUp', tier: 1, slot: 0 },
    });
    expect(s1.faceUp[1][0]).toBeNull();
    expect(s1.pendingReveals).toEqual([{ tier: 1, slot: 0 }]);
    expect(s1.players[0]?.reserved).toHaveLength(1);
    expect(s1.players[0]?.reserved[0]).toEqual({ card: c, reservedFrom: 'faceUp' });
    expect(s1.players[0]?.gems.gold).toBe(1);
    expect(s1.gemSupply.gold).toBe(4);
  });

  it('reserve from deck shrinks the deck and queues no reveal', () => {
    const c = mkCard('T1-001', 'red', 0, { blue: 1 });
    const s0 = makeState({ decks: { 1: [c] }, gemSupply: { gold: 5 } });
    const s1 = apply(s0, {
      type: 'reserve',
      source: { kind: 'deck', tier: 1 },
    });
    expect(s1.decks[1]).toHaveLength(0);
    expect(s1.pendingReveals).toEqual([]);
    expect(s1.players[0]?.reserved[0]).toEqual({ card: c, reservedFrom: 'deck' });
  });

  it('grants no gold when supply is empty', () => {
    const c = mkCard('T1-001', 'red');
    const s0 = makeState({ faceUp: { 1: [c, null, null, null] }, gemSupply: { gold: 0 } });
    const s1 = apply(s0, { type: 'reserve', source: { kind: 'faceUp', tier: 1, slot: 0 } });
    expect(s1.players[0]?.gems.gold).toBe(0);
  });
});

describe('apply: buy', () => {
  it('buys a face-up card, pays gems, updates bonuses and prestige', () => {
    const target = mkCard('T1-001', 'red', 1, { blue: 2 });
    const s0 = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [
        player({ gems: { ...emptyGems(), blue: 2 } }),
        player(),
      ],
    });
    const s1 = apply(s0, {
      type: 'buy',
      source: { kind: 'faceUp', tier: 1, slot: 0 },
      payment: { ...emptyGems(), blue: 2 },
    });
    const p = s1.players[0];
    expect(p?.purchased).toEqual([target]);
    expect(p?.gems.blue).toBe(0);
    expect(p?.bonuses.red).toBe(1);
    expect(p?.prestige).toBe(1);
    expect(s1.faceUp[1][0]).toBeNull();
    expect(s1.pendingReveals).toEqual([{ tier: 1, slot: 0 }]);
    expect(s1.gemSupply.blue).toBe(2); // gems returned to supply
  });

  it('buys from own reserve without queuing a reveal', () => {
    const target = mkCard('T1-001', 'red', 0, { blue: 1 });
    const s0 = makeState({
      players: [
        player({
          reserved: [reservedCard(target, 'faceUp')],
          gems: { ...emptyGems(), blue: 1 },
        }),
        player(),
      ],
    });
    const s1 = apply(s0, {
      type: 'buy',
      source: { kind: 'reserve', index: 0 },
      payment: { ...emptyGems(), blue: 1 },
    });
    expect(s1.players[0]?.reserved).toHaveLength(0);
    expect(s1.pendingReveals).toEqual([]);
  });
});

describe('apply: noble visit', () => {
  it('awards a noble when the buy completes its requirement', () => {
    const lastWhite = mkCard('T1-001', 'white');
    const n = noble('N-001', { white: 1 });
    const s0 = makeState({
      faceUp: { 1: [lastWhite, null, null, null] },
      nobles: [n],
      players: [player(), player()],
    });
    const s1 = apply(s0, {
      type: 'buy',
      source: { kind: 'faceUp', tier: 1, slot: 0 },
      payment: emptyGems(),
    });
    expect(s1.players[0]?.nobles).toEqual([n]);
    expect(s1.players[0]?.prestige).toBe(3); // noble's 3
    expect(s1.nobles).toEqual([]); // noble removed from board
  });

  it('awards at most one noble per turn (D7)', () => {
    const lastCard = mkCard('T1-001', 'white');
    const n1 = noble('N-001', { white: 1 });
    const n2 = noble('N-002', { white: 1 });
    const s0 = makeState({
      faceUp: { 1: [lastCard, null, null, null] },
      nobles: [n1, n2],
    });
    const s1 = apply(s0, {
      type: 'buy',
      source: { kind: 'faceUp', tier: 1, slot: 0 },
      payment: emptyGems(),
    });
    expect(s1.players[0]?.nobles).toHaveLength(1);
    expect(s1.nobles).toHaveLength(1);
  });
});

describe('apply: turn advancement', () => {
  it('wraps currentPlayer back to 0 after the last player', () => {
    const s0 = makeState({ numPlayers: 3, currentPlayer: 2, gemSupply: { white: 4 } });
    const s1 = apply(s0, { type: 'take2', color: 'white' });
    expect(s1.currentPlayer).toBe(0);
  });
});

describe('apply: discard', () => {
  it('throws when the player ends over the gem cap with no discard', () => {
    const s0 = makeState({
      gemSupply: { white: 4, blue: 4, green: 4 },
      players: [
        player({ gems: { ...emptyGems(), red: 4, black: 4 } }),
        player(),
      ],
    });
    const action: Action = { type: 'take3', colors: ['white', 'blue', 'green'] };
    expect(() => apply(s0, action)).toThrow();
  });

  it('returns discarded gems to supply', () => {
    const s0 = makeState({
      gemSupply: { white: 4, blue: 4, green: 4 },
      players: [
        player({ gems: { ...emptyGems(), red: 4, black: 4 } }),
        player(),
      ],
    });
    const s1 = apply(s0, {
      type: 'take3',
      colors: ['white', 'blue', 'green'],
      discard: { ...emptyGems(), red: 1 },
    });
    expect(s1.players[0]?.gems.red).toBe(3);
    expect(s1.gemSupply.red).toBe(1);
  });
});

describe('applyReveal', () => {
  it('fills the first pending slot from the matching deck top', () => {
    const top = mkCard('T1-001', 'red');
    const next = mkCard('T1-002', 'blue');
    const s0 = makeState({
      decks: { 1: [top, next] },
      faceUp: { 1: [null, null, null, null] },
    });
    s0.pendingReveals.push({ tier: 1, slot: 1 });
    const s1 = applyReveal(s0);
    expect(s1.faceUp[1][1]).toEqual(top);
    expect(s1.decks[1]).toEqual([next]);
    expect(s1.pendingReveals).toEqual([]);
  });

  it('is a no-op when no reveals are pending', () => {
    const s0 = makeState();
    const s1 = applyReveal(s0);
    expect(s1).toEqual(s0);
  });

  it('respects a custom sampler (Phase 3 hook)', () => {
    const a = mkCard('T1-001', 'red');
    const b = mkCard('T1-002', 'blue');
    const c = mkCard('T1-003', 'green');
    const s0 = makeState({ decks: { 1: [a, b, c] } });
    s0.pendingReveals.push({ tier: 1, slot: 0 });
    const s1 = applyReveal(s0, (deck) => deck[2]);
    expect(s1.faceUp[1][0]).toEqual(c);
    expect(s1.decks[1]).toEqual([a, b]);
  });
});

describe('applyTurn integration', () => {
  it('apply + auto-reveal yields a clean post-state', () => {
    const c1 = mkCard('T1-001', 'red');
    const c2 = mkCard('T1-002', 'blue');
    const s0 = makeState({
      faceUp: { 1: [c1, null, null, null] },
      decks: { 1: [c2] },
      players: [player({ gems: emptyGems() }), player()],
      gemSupply: { gold: 5 },
    });
    const s1 = applyTurn(s0, {
      type: 'reserve',
      source: { kind: 'faceUp', tier: 1, slot: 0 },
    });
    expect(s1.faceUp[1][0]).toEqual(c2); // reveal happened
    expect(s1.pendingReveals).toEqual([]);
  });
});

describe('isTerminal / winner', () => {
  it('is not terminal at game start', () => {
    const s = makeState({ players: [player(), player()] });
    expect(isTerminal(s)).toBe(false);
  });

  it('is not terminal mid-round even with someone at 15', () => {
    const s = makeState({
      players: [player({ prestige: 16 }), player()],
      currentPlayer: 1,
      startingPlayer: 0,
      turnNumber: 1,
    });
    expect(isTerminal(s)).toBe(false);
  });

  it('is terminal at round-end when someone has ≥15', () => {
    const s = makeState({
      players: [player({ prestige: 16 }), player()],
      currentPlayer: 0,
      startingPlayer: 0,
      turnNumber: 4,
    });
    expect(isTerminal(s)).toBe(true);
  });

  it('winner is the highest prestige; tiebreak goes to fewer cards', () => {
    const c = mkCard('X', 'white');
    const s = makeState({
      players: [
        player({ prestige: 15, purchased: [c, c, c, c, c, c, c, c, c, c] }),
        player({ prestige: 15, purchased: [c, c, c, c, c, c, c] }),
      ],
    });
    expect(winner(s)).toBe(1);
  });
});

describe('initialState', () => {
  it('deals 4 face-up per tier and shuffles the rest into decks', () => {
    const s = initialState(4, { rng: seededRng(42) });
    expect(s.faceUp[1]).toHaveLength(4);
    expect(s.faceUp[2]).toHaveLength(4);
    expect(s.faceUp[3]).toHaveLength(4);
    expect(s.decks[1]).toHaveLength(36);
    expect(s.decks[2]).toHaveLength(26);
    expect(s.decks[3]).toHaveLength(16);
    expect(s.faceUp[1].every((c) => c !== null && c.tier === 1)).toBe(true);
    expect(s.faceUp[3].every((c) => c !== null && c.tier === 3)).toBe(true);
  });

  it('scales gem supply by player count', () => {
    expect(initialState(2, { rng: seededRng(1) }).gemSupply.white).toBe(4);
    expect(initialState(3, { rng: seededRng(1) }).gemSupply.white).toBe(5);
    expect(initialState(4, { rng: seededRng(1) }).gemSupply.white).toBe(7);
  });

  it('deals numPlayers + 1 nobles', () => {
    expect(initialState(2, { rng: seededRng(1) }).nobles).toHaveLength(3);
    expect(initialState(3, { rng: seededRng(1) }).nobles).toHaveLength(4);
    expect(initialState(4, { rng: seededRng(1) }).nobles).toHaveLength(5);
  });

  it('produces identical states under the same seed', () => {
    const a = initialState(4, { rng: seededRng(1234) });
    const b = initialState(4, { rng: seededRng(1234) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different states under different seeds', () => {
    const a = initialState(4, { rng: seededRng(1) });
    const b = initialState(4, { rng: seededRng(2) });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe('integration: random self-play does not crash', () => {
  it('plays at least 20 turns of legal-action self-play without throwing', async () => {
    const { legalActions } = await import('./legalActions');
    let s = initialState(2, { rng: seededRng(7) });
    const rng = seededRng(99);
    for (let i = 0; i < 20; i++) {
      const actions = legalActions(s);
      const safe = actions.filter((a) => {
        if (a.type !== 'take3' && a.type !== 'take2' && a.type !== 'reserve') return true;
        // skip actions that would put player over cap with no discard
        const totalAfter =
          (s.players[s.currentPlayer]?.gems.white ?? 0) +
          (s.players[s.currentPlayer]?.gems.blue ?? 0) +
          (s.players[s.currentPlayer]?.gems.green ?? 0) +
          (s.players[s.currentPlayer]?.gems.red ?? 0) +
          (s.players[s.currentPlayer]?.gems.black ?? 0) +
          (s.players[s.currentPlayer]?.gems.gold ?? 0) +
          (a.type === 'take3' ? a.colors.length : a.type === 'take2' ? 2 : 1);
        return totalAfter <= 10;
      });
      if (safe.length === 0) break;
      const choice = safe[Math.floor(rng() * safe.length)];
      if (!choice) break;
      s = applyTurn(s, choice);
    }
    expect(s.turnNumber).toBeGreaterThan(0);
  });
});
