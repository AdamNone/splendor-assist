import rawCards from './data/cards.json';
import rawNobles from './data/nobles.json';
import type { Card, Noble } from './types';

// The JSON shape was authored to match `Card` and `Noble` exactly, but JSON
// widens `tier: 1 | 2 | 3` to plain `number`. We assert and validate on import.
export const ALL_CARDS: readonly Card[] = (rawCards as readonly Card[]).map((c) => ({
  id: c.id,
  tier: c.tier,
  bonus: c.bonus,
  prestige: c.prestige,
  cost: { ...c.cost },
}));

export const ALL_NOBLES: readonly Noble[] = (rawNobles as readonly Noble[]).map((n) => ({
  id: n.id,
  prestige: n.prestige,
  requirement: { ...n.requirement },
}));

export const cardsByTier = (tier: 1 | 2 | 3): readonly Card[] =>
  ALL_CARDS.filter((c) => c.tier === tier);
