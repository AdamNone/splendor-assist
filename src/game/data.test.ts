import { describe, expect, it } from 'vitest';
import { ALL_CARDS, ALL_NOBLES, cardsByTier } from './data';
import { COLORS } from './types';
import type { Color, Tier } from './types';

describe('card data', () => {
  it('has the canonical 90 cards split 40 / 30 / 20', () => {
    expect(ALL_CARDS).toHaveLength(90);
    expect(cardsByTier(1)).toHaveLength(40);
    expect(cardsByTier(2)).toHaveLength(30);
    expect(cardsByTier(3)).toHaveLength(20);
  });

  it('has 18 cards of each bonus color (8+6+4 across tiers)', () => {
    const counts: Record<Color, number> = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
    for (const c of ALL_CARDS) counts[c.bonus] += 1;
    for (const c of COLORS) expect(counts[c]).toBe(18);
  });

  it('has the expected per-tier bonus distribution', () => {
    const expected: Record<Tier, number> = { 1: 8, 2: 6, 3: 4 };
    for (const tier of [1, 2, 3] as Tier[]) {
      const counts: Record<Color, number> = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
      for (const c of cardsByTier(tier)) counts[c.bonus] += 1;
      for (const c of COLORS) expect(counts[c]).toBe(expected[tier]);
    }
  });

  it('has unique IDs', () => {
    const ids = new Set(ALL_CARDS.map((c) => c.id));
    expect(ids.size).toBe(ALL_CARDS.length);
  });

  it('matches expected prestige counts per tier', () => {
    // Tier 1: 35 cards with 0 prestige, 5 cards with 1 prestige
    const tier1 = cardsByTier(1);
    expect(tier1.filter((c) => c.prestige === 0)).toHaveLength(35);
    expect(tier1.filter((c) => c.prestige === 1)).toHaveLength(5);

    // Tier 2: 10 with 1, 15 with 2, 5 with 3
    const tier2 = cardsByTier(2);
    expect(tier2.filter((c) => c.prestige === 1)).toHaveLength(10);
    expect(tier2.filter((c) => c.prestige === 2)).toHaveLength(15);
    expect(tier2.filter((c) => c.prestige === 3)).toHaveLength(5);

    // Tier 3: 5 with 3, 10 with 4, 5 with 5
    const tier3 = cardsByTier(3);
    expect(tier3.filter((c) => c.prestige === 3)).toHaveLength(5);
    expect(tier3.filter((c) => c.prestige === 4)).toHaveLength(10);
    expect(tier3.filter((c) => c.prestige === 5)).toHaveLength(5);
  });
});

describe('noble data', () => {
  it('has 10 nobles, each worth 3 prestige', () => {
    expect(ALL_NOBLES).toHaveLength(10);
    for (const n of ALL_NOBLES) expect(n.prestige).toBe(3);
  });

  it('has unique IDs', () => {
    const ids = new Set(ALL_NOBLES.map((n) => n.id));
    expect(ids.size).toBe(ALL_NOBLES.length);
  });

  it('every noble requires either 4+4 of two colors or 3+3+3 of three colors', () => {
    for (const n of ALL_NOBLES) {
      const total = COLORS.reduce((s, c) => s + n.requirement[c], 0);
      expect([8, 9]).toContain(total);
      const fours = COLORS.filter((c) => n.requirement[c] === 4).length;
      const threes = COLORS.filter((c) => n.requirement[c] === 3).length;
      const used = COLORS.filter((c) => n.requirement[c] > 0).length;
      if (total === 8) {
        expect(fours).toBe(2);
        expect(used).toBe(2);
      } else {
        expect(threes).toBe(3);
        expect(used).toBe(3);
      }
    }
  });
});
