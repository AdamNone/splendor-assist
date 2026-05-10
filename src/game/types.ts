export const COLORS = ['white', 'blue', 'green', 'red', 'black'] as const;
export type Color = (typeof COLORS)[number];

export const GEM_COLORS = [...COLORS, 'gold'] as const;
export type GemColor = (typeof GEM_COLORS)[number];

export type ColorCount = Record<Color, number>;
export type GemPool = Record<GemColor, number>;

export type Tier = 1 | 2 | 3;
export const TIERS: readonly Tier[] = [1, 2, 3];

export type Card = {
  id: string;
  tier: Tier;
  bonus: Color;
  prestige: number;
  cost: ColorCount;
};

export type Noble = {
  id: string;
  prestige: number;
  requirement: ColorCount;
};

export type FaceUpSlot = Card | null;

export type PlayerIndex = 0 | 1 | 2 | 3;

export type PlayerState = {
  gems: GemPool;
  purchased: Card[];
  reserved: Card[];
  nobles: Noble[];
};

export type PendingReveal = { tier: Tier; slot: number };

export type GameState = {
  numPlayers: 2 | 3 | 4;
  decks: Record<Tier, Card[]>;
  faceUp: Record<Tier, FaceUpSlot[]>;
  gemSupply: GemPool;
  nobles: Noble[];
  players: PlayerState[];
  currentPlayer: PlayerIndex;
  pendingReveals: PendingReveal[];
  finalRoundTriggered: boolean;
  finalRoundStarter: PlayerIndex | null;
  turnNumber: number;
};

export type CardSource =
  | { kind: 'faceUp'; tier: Tier; slot: number }
  | { kind: 'deck'; tier: Tier };

export type BuySource =
  | { kind: 'faceUp'; tier: Tier; slot: number }
  | { kind: 'reserve'; index: number };

export type Action =
  | { type: 'take3'; colors: Color[]; discard?: GemPool }
  | { type: 'take2'; color: Color; discard?: GemPool }
  | { type: 'reserve'; source: CardSource; discard?: GemPool }
  | { type: 'buy'; source: BuySource; payment: GemPool };

export const FACE_UP_PER_TIER = 4;
export const RESERVE_LIMIT = 3;
export const GEM_HAND_LIMIT = 10;
export const TAKE_2_MIN_PILE = 4;
export const PRESTIGE_TO_TRIGGER_END = 15;
