import type {
  Card,
  GameState,
  GemPool,
  Noble,
  PlayerState,
} from './types';
import { emptyColorCount, emptyGemPool } from './gems';
import { ALL_CARDS, ALL_NOBLES } from './data';

export type Rng = () => number;

/** Deterministic seedable RNG (LCG). For unit tests; not cryptographically random. */
export const seededRng = (seed: number): Rng => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
};

const shuffled = <T>(arr: readonly T[], rng: Rng): T[] => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
};

const GEM_SUPPLY_BY_PLAYERS: Record<2 | 3 | 4, GemPool> = {
  2: { white: 4, blue: 4, green: 4, red: 4, black: 4, gold: 5 },
  3: { white: 5, blue: 5, green: 5, red: 5, black: 5, gold: 5 },
  4: { white: 7, blue: 7, green: 7, red: 7, black: 7, gold: 5 },
};

const emptyPlayer = (): PlayerState => ({
  gems: emptyGemPool(),
  purchased: [],
  reserved: [],
  nobles: [],
  bonuses: emptyColorCount(),
  prestige: 0,
});

export type SetupOptions = {
  cards?: readonly Card[];
  nobles?: readonly Noble[];
  rng?: Rng;
};

/**
 * Build a fresh-deal Splendor state. Decks are shuffled; the first 4 of each
 * tier go face-up. Nobles are shuffled and the first `numPlayers + 1` are
 * dealt face-up. Gem supply scales with player count per the standard rules.
 */
export const initialState = (
  numPlayers: 2 | 3 | 4,
  opts: SetupOptions = {},
): GameState => {
  const cards = opts.cards ?? ALL_CARDS;
  const nobles = opts.nobles ?? ALL_NOBLES;
  const rng = opts.rng ?? Math.random;

  const tier1 = shuffled(cards.filter((c) => c.tier === 1), rng);
  const tier2 = shuffled(cards.filter((c) => c.tier === 2), rng);
  const tier3 = shuffled(cards.filter((c) => c.tier === 3), rng);

  const dealtNobles = shuffled(nobles, rng).slice(0, numPlayers + 1);

  return {
    numPlayers,
    decks: {
      1: tier1.slice(4),
      2: tier2.slice(4),
      3: tier3.slice(4),
    },
    faceUp: {
      1: tier1.slice(0, 4),
      2: tier2.slice(0, 4),
      3: tier3.slice(0, 4),
    },
    gemSupply: { ...GEM_SUPPLY_BY_PLAYERS[numPlayers] },
    nobles: dealtNobles,
    players: Array.from({ length: numPlayers }, emptyPlayer),
    currentPlayer: 0,
    startingPlayer: 0,
    pendingReveals: [],
    turnNumber: 0,
  };
};
