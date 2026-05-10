import { emptyColorCount, emptyGemPool } from './gems';
import type {
  Card,
  Color,
  ColorCount,
  GameState,
  GemPool,
  Noble,
  PlayerState,
  ReservedCard,
  ReservedSource,
  Tier,
} from './types';

export const card = (
  id: string,
  tier: Tier,
  bonus: Color,
  prestige: number,
  cost: Partial<ColorCount>,
): Card => ({
  id,
  tier,
  bonus,
  prestige,
  cost: { ...emptyColorCount(), ...cost },
});

export const noble = (
  id: string,
  requirement: Partial<ColorCount>,
  prestige = 3,
): Noble => ({
  id,
  prestige,
  requirement: { ...emptyColorCount(), ...requirement },
});

export const gems = (overrides: Partial<GemPool> = {}): GemPool => ({
  ...emptyGemPool(),
  ...overrides,
});

export const reservedCard = (
  c: Card,
  reservedFrom: ReservedSource = 'faceUp',
): ReservedCard => ({ card: c, reservedFrom });

export const player = (overrides: Partial<PlayerState> = {}): PlayerState => {
  const purchased = overrides.purchased ?? [];
  const nobles = overrides.nobles ?? [];
  const bonuses = overrides.bonuses ?? (() => {
    const b = emptyColorCount();
    for (const c of purchased) b[c.bonus] += 1;
    return b;
  })();
  let prestige = overrides.prestige;
  if (prestige === undefined) {
    prestige = 0;
    for (const c of purchased) prestige += c.prestige;
    for (const n of nobles) prestige += n.prestige;
  }
  return {
    gems: overrides.gems ?? emptyGemPool(),
    purchased,
    reserved: overrides.reserved ?? [],
    nobles,
    bonuses,
    prestige,
  };
};

type StateOverrides = {
  numPlayers?: 2 | 3 | 4;
  gemSupply?: Partial<GemPool>;
  faceUp?: Partial<Record<Tier, (Card | null)[]>>;
  decks?: Partial<Record<Tier, Card[]>>;
  nobles?: Noble[];
  players?: PlayerState[];
  currentPlayer?: 0 | 1 | 2 | 3;
  startingPlayer?: 0 | 1 | 2 | 3;
  turnNumber?: number;
};

export const makeState = (overrides: StateOverrides = {}): GameState => {
  const numPlayers = overrides.numPlayers ?? 2;
  return {
    numPlayers,
    decks: { 1: [], 2: [], 3: [], ...overrides.decks },
    faceUp: {
      1: [null, null, null, null],
      2: [null, null, null, null],
      3: [null, null, null, null],
      ...overrides.faceUp,
    },
    gemSupply: gems(overrides.gemSupply),
    nobles: overrides.nobles ?? [],
    players: overrides.players ?? Array.from({ length: numPlayers }, () => player()),
    currentPlayer: overrides.currentPlayer ?? 0,
    startingPlayer: overrides.startingPlayer ?? 0,
    pendingReveals: [],
    turnNumber: overrides.turnNumber ?? 0,
  };
};
