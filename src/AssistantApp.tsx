import { useEffect, useMemo, useRef, useState } from 'react';
// useMemo is used inside CardPickerModal below.
import { apply, applyAllReveals, isTerminal, winner } from './game/apply';
import { computePayment, meetsNobleRequirement } from './game/gems';
import { mctsBestActionWithStats } from './game/mcts';
import type { MctsCandidate } from './game/mcts';
import { evaluateV3 } from './game/evaluate';
import { ALL_CARDS, ALL_NOBLES } from './game/data';
import { narrate } from './game/narrate';
import { seededRng, initialState as freshGameState } from './game/setup';
import {
  COLORS,
  GEM_COLORS,
  GEM_HAND_LIMIT,
  TAKE_2_MIN_PILE,
  TIERS,
} from './game/types';
import type {
  Action,
  Card,
  Color,
  ColorCount,
  GameState,
  GemPool,
  Noble,
  PlayerIndex,
  PlayerState,
  Tier,
} from './game/types';
import './assistant.css';

const COLOR_HEX: Record<Color, string> = {
  white: '#f4ead5',
  blue: '#2563eb',
  green: '#15803d',
  red: '#dc2626',
  black: '#1f2937',
};
const GOLD_HEX = '#eab308';

const emptyColorCount = (): ColorCount => ({
  white: 0, blue: 0, green: 0, red: 0, black: 0,
});
const emptyGemPool = (): GemPool => ({ ...emptyColorCount(), gold: 0 });

// Standard Splendor gem supply per player count.
const GEM_SUPPLY_DEFAULT: Record<2 | 3 | 4, GemPool> = {
  2: { white: 4, blue: 4, green: 4, red: 4, black: 4, gold: 5 },
  3: { white: 5, blue: 5, green: 5, red: 5, black: 5, gold: 5 },
  4: { white: 7, blue: 7, green: 7, red: 7, black: 7, gold: 5 },
};

type ReservedFormCard = {
  card: Card;
  /**
   * True if this card was reserved blindly from a deck top (opponent reserve
   * we couldn't see). The engine has assigned a best-guess identity to keep
   * MCTS running, but in real play the user doesn't know which card it is —
   * so the UI renders it face-down with only the tier visible.
   */
  blind?: boolean;
};

type PlayerForm = {
  bonuses: ColorCount;
  gems: GemPool;
  prestige: number;
  reserved: ReservedFormCard[];
};

type FaceUpGrid = Record<Tier, Array<Card | null>>;

type AssistantState = {
  numPlayers: 2 | 3 | 4;
  currentPlayer: PlayerIndex;
  /**
   * Seat that started this game. The end-of-round rule needs it: a Splendor
   * game ends the turn currentPlayer wraps back to startingPlayer after
   * someone has hit 15 prestige. Persisted so reloads keep tracking.
   */
  startingPlayer: PlayerIndex;
  /**
   * Number of plies played in this game (incremented by apply()). Combined
   * with startingPlayer to detect end-of-round terminality.
   */
  turnNumber: number;
  /**
   * The player the assistant works for. Only this player gets
   * auto-recommendations. Defaults to P0; reconfigurable in the header.
   */
  mainPlayer: PlayerIndex;
  /**
   * Optional display names per seat. Index `i` is the name for player at
   * seat `i`. Empty string (or missing entry) falls back to "P0" / "P1" /
   * etc. at display time.
   */
  playerNames: string[];
  gemSupply: GemPool;
  faceUp: FaceUpGrid;
  nobles: Noble[];
  players: PlayerForm[];
  /**
   * IDs of every card that has ever been visible (face-up entry, manual
   * reserve add, or blind reserve drawn by the engine). Cards in seenIds
   * are no longer in their tier deck. Used to compute remaining deck size
   * per tier — when a tier deck is exhausted, validate() allows that tier's
   * face-up slot(s) to stay empty.
   */
  seenIds: string[];
};

const defaultPlayerName = (idx: number): string => `P${idx}`;

const emptyPlayer = (): PlayerForm => ({
  bonuses: emptyColorCount(),
  gems: emptyGemPool(),
  prestige: 0,
  reserved: [],
});

const emptyFaceUp = (): FaceUpGrid => ({
  1: [null, null, null, null],
  2: [null, null, null, null],
  3: [null, null, null, null],
});

const STORAGE_KEY = 'splendor-assistant-state-v1';

const initialState = (): AssistantState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as AssistantState;
      // Rehydrate cards/nobles by id so we have live references.
      const cardsById = new Map<string, Card>(ALL_CARDS.map((c) => [c.id, c]));
      const noblesById = new Map<string, Noble>(ALL_NOBLES.map((n) => [n.id, n]));
      const rehydrateGrid = (g: FaceUpGrid): FaceUpGrid => ({
        1: g[1].map((c) => (c === null ? null : cardsById.get(c.id) ?? null)),
        2: g[2].map((c) => (c === null ? null : cardsById.get(c.id) ?? null)),
        3: g[3].map((c) => (c === null ? null : cardsById.get(c.id) ?? null)),
      });
      const rehydratedFaceUp = rehydrateGrid(parsed.faceUp);
      const rehydratedPlayers: PlayerForm[] = parsed.players.map((p) => ({
        ...p,
        reserved: Array.isArray(p.reserved)
          ? p.reserved.flatMap((r) => {
              const card = cardsById.get(r.card?.id);
              if (card === undefined) return [];
              return [{ card, ...(r.blind === true ? { blind: true } : {}) }];
            })
          : [],
      }));
      // seenIds: prefer the saved set; if missing (older save format),
      // reconstruct conservatively from whatever is currently visible.
      let seenIds: string[];
      if (Array.isArray(parsed.seenIds)) {
        seenIds = parsed.seenIds.filter((id): id is string => typeof id === 'string');
      } else {
        const set = new Set<string>();
        for (const tier of TIERS) {
          for (const c of rehydratedFaceUp[tier]) {
            if (c !== null) set.add(c.id);
          }
        }
        for (const p of rehydratedPlayers) {
          for (const r of p.reserved) set.add(r.card.id);
        }
        seenIds = Array.from(set);
      }
      return {
        ...parsed,
        mainPlayer: (parsed.mainPlayer ?? 0) as PlayerIndex,
        startingPlayer: ((parsed as Partial<AssistantState>).startingPlayer ?? 0) as PlayerIndex,
        turnNumber: typeof (parsed as Partial<AssistantState>).turnNumber === 'number'
          ? (parsed as AssistantState).turnNumber
          : 0,
        playerNames: Array.isArray(parsed.playerNames) ? parsed.playerNames : [],
        faceUp: rehydratedFaceUp,
        nobles: parsed.nobles
          .map((n) => noblesById.get(n.id))
          .filter((n): n is Noble => n !== undefined),
        players: rehydratedPlayers,
        seenIds,
      };
    }
  } catch {
    /* fall through to fresh */
  }
  return {
    numPlayers: 2,
    currentPlayer: 0,
    startingPlayer: 0,
    turnNumber: 0,
    mainPlayer: 0,
    playerNames: [],
    gemSupply: { ...GEM_SUPPLY_DEFAULT[2] },
    faceUp: emptyFaceUp(),
    nobles: [],
    players: [emptyPlayer(), emptyPlayer()],
    seenIds: [],
  };
};

type Alternative = {
  action: Action;
  summary: string;
  visits: number;
  meanReward: number;
};

type Recommendation = {
  bestAction: Action;
  summary: string;
  /** Plain-language consequences of applying `bestAction`. */
  explanation: string[];
  /** Generic Splendor lessons tied to this action. */
  strategy: string[];
  winRates: number[];
  currentPlayer: number;
  rootVisits: number;
  alternatives: Alternative[];
  thinkingMs: number;
};

/**
 * Pull the user-editable fields out of a fresh GameState (e.g. one we just
 * produced via `apply`) back into our AssistantState. Preserves
 * settings (mainPlayer) that aren't part of the engine state.
 */
const fromGameState = (gs: GameState, prev: AssistantState): AssistantState => ({
  numPlayers: gs.numPlayers,
  currentPlayer: gs.currentPlayer,
  startingPlayer: gs.startingPlayer,
  turnNumber: gs.turnNumber,
  mainPlayer: prev.mainPlayer,
  playerNames: prev.playerNames,
  // seenIds is owned by the assistant, not the engine — carry it forward.
  // Callers that need to extend it (e.g. onApply after a blind reserve)
  // override seenIds after spreading the fromGameState result.
  seenIds: prev.seenIds,
  gemSupply: { ...gs.gemSupply },
  faceUp: {
    1: gs.faceUp[1].slice(),
    2: gs.faceUp[2].slice(),
    3: gs.faceUp[3].slice(),
  },
  nobles: gs.nobles.slice(),
  players: gs.players.slice(0, gs.numPlayers).map((p) => ({
    bonuses: { ...p.bonuses },
    gems: { ...p.gems },
    prestige: p.prestige,
    // Preserve every reserve, marking deck-source ones as blind so the UI
    // renders them face-down. The engine's best-guess identity comes along
    // for MCTS purposes but is not exposed visually.
    reserved: p.reserved.map((r) => ({
      card: r.card,
      ...(r.reservedFrom === 'deck' ? { blind: true } : {}),
    })),
  })),
});

/**
 * Cards still in the deck for tier T = every tier-T card that has never been
 * seen. seenIds is maintained as cards flow through the UI, so this is exact
 * (no overstating from forgotten purchases like the old `used = faceUp ∪
 * reserved` approach).
 */
const tierDeckRemaining = (s: AssistantState, tier: Tier): Card[] => {
  const seen = new Set(s.seenIds);
  return ALL_CARDS.filter((c) => c.tier === tier && !seen.has(c.id));
};

const buildGameState = (s: AssistantState): GameState => {
  const decks = {
    1: tierDeckRemaining(s, 1),
    2: tierDeckRemaining(s, 2),
    3: tierDeckRemaining(s, 3),
  };
  const players: PlayerState[] = s.players.slice(0, s.numPlayers).map((p) => ({
    gems: { ...p.gems },
    purchased: [],
    // The form only carries face-up-source reserves (see ReservedFormCard
    // comment); rebuild them with the right `reservedFrom` tag here.
    reserved: p.reserved.map((r) => ({
      card: r.card,
      reservedFrom: (r.blind === true ? 'deck' : 'faceUp') as 'deck' | 'faceUp',
    })),
    nobles: [],
    bonuses: { ...p.bonuses },
    prestige: p.prestige,
  }));
  return {
    numPlayers: s.numPlayers,
    decks,
    faceUp: {
      1: s.faceUp[1].slice(),
      2: s.faceUp[2].slice(),
      3: s.faceUp[3].slice(),
    },
    gemSupply: { ...s.gemSupply },
    nobles: s.nobles.slice(),
    players,
    currentPlayer: s.currentPlayer,
    startingPlayer: s.startingPlayer,
    pendingReveals: [],
    turnNumber: s.turnNumber,
  };
};

const describeAction = (state: GameState, action: Action): string => {
  return narrate(state, action);
};

// Inline visual chip used by ActionSummary. `gem` keeps the round-token
// look to match player tableau gems; without it the chip renders as a
// rounded-square (bonus-like).
function ColorChip({
  color,
  count,
  gem = true,
}: {
  color: Color | 'gold';
  count?: number;
  gem?: boolean;
}) {
  const bg = color === 'gold' ? GOLD_HEX : COLOR_HEX[color];
  return (
    <span className="action-chip" title={color}>
      <span
        className={`swatch ${gem ? 'gem' : ''}`}
        style={{ background: bg }}
      />
      {count !== undefined && count > 1 && (
        <span className="action-chip-count">{count}</span>
      )}
    </span>
  );
}

// Compact "T2 [bonus-color] 3p" inline pill for a card target.
function CardPill({ card }: { card: Card }) {
  return (
    <span className="action-card-pill">
      <span className="action-card-tier">T{card.tier}</span>
      <span
        className="swatch"
        style={{ background: COLOR_HEX[card.bonus] }}
        title={`+1 ${card.bonus} bonus`}
      />
      {card.prestige > 0 && (
        <span className="action-card-prestige">{card.prestige}p</span>
      )}
    </span>
  );
}

// Renders an Action as inline JSX with colored chips instead of the
// W/B/G/R/K letter codes from narrate(). Used in the recommendation
// summary and the alternatives list. `state` should be the pre-action
// state (so faceUp sources resolve to the right card).
function ActionSummary({ state, action }: { state: GameState; action: Action }) {
  switch (action.type) {
    case 'take3':
      return (
        <span className="action-summary">
          <span className="action-verb">Take 3:</span>
          {action.colors.map((c) => (
            <ColorChip key={c} color={c} />
          ))}
        </span>
      );
    case 'take2':
      return (
        <span className="action-summary">
          <span className="action-verb">Take 2:</span>
          <ColorChip color={action.color} />
          <ColorChip color={action.color} />
        </span>
      );
    case 'reserve': {
      if (action.source.kind === 'deck') {
        return (
          <span className="action-summary">
            <span className="action-verb">Reserve</span>
            <span className="action-card-pill">
              T{action.source.tier} <span className="action-card-blind">blind</span>
            </span>
          </span>
        );
      }
      const card = state.faceUp[action.source.tier][action.source.slot];
      return (
        <span className="action-summary">
          <span className="action-verb">Reserve</span>
          {card ? <CardPill card={card} /> : <span>T{action.source.tier}?</span>}
        </span>
      );
    }
    case 'buy': {
      let card: Card | undefined;
      let fromReserve = false;
      if (action.source.kind === 'faceUp') {
        card = state.faceUp[action.source.tier][action.source.slot] ?? undefined;
      } else {
        card = state.players[state.currentPlayer]?.reserved[action.source.index]?.card;
        fromReserve = true;
      }
      const payment = GEM_COLORS.filter((c) => action.payment[c] > 0);
      return (
        <span className="action-summary">
          <span className="action-verb">Buy</span>
          {card ? <CardPill card={card} /> : <span>?</span>}
          {fromReserve && <span className="action-from-reserve">from reserve</span>}
          {payment.length > 0 && (
            <>
              <span className="action-pay-label">pay</span>
              {payment.map((c) => (
                <ColorChip key={c} color={c} count={action.payment[c]} />
              ))}
            </>
          )}
        </span>
      );
    }
  }
}

const nobleDescription = (n: Noble): string =>
  COLORS.filter((c) => n.requirement[c] > 0)
    .map((c) => `${n.requirement[c]} ${c}`)
    .join(' + ');

/**
 * Concrete, plain-language consequences of `action` going from `before` to
 * `after`. Returns one short sentence per consequence; nothing is added for
 * a dimension that didn't change. Designed for the "Why this move" panel —
 * not a feature-by-feature breakdown of the evaluator (those numbers don't
 * mean anything to a human at the table), just "what actually happens."
 */
const explainAction = (
  before: GameState,
  after: GameState,
  me: PlayerIndex,
  action: Action,
  playerLabel: (idx: number) => string,
): string[] => {
  const lines: string[] = [];
  const beforeMe = before.players[me];
  const afterMe = after.players[me];
  if (beforeMe === undefined || afterMe === undefined) return lines;

  // 1. Direct prestige delta from the action (excludes noble's +3, which is
  //    surfaced separately below for clarity).
  const claimedNobles = before.nobles.filter(
    (n) => !after.nobles.some((x) => x.id === n.id),
  );
  const noblePrestige = claimedNobles.reduce((s, n) => s + n.prestige, 0);
  const directPrestigeDelta = (afterMe.prestige - beforeMe.prestige) - noblePrestige;
  if (directPrestigeDelta > 0) {
    lines.push(`+${directPrestigeDelta} prestige (now ${afterMe.prestige - noblePrestige}).`);
  }

  // 2. New bonus(es). Splendor caps a single action at +1 bonus, but the
  //    loop handles weirder cases without special-casing.
  for (const c of COLORS) {
    const dB = afterMe.bonuses[c] - beforeMe.bonuses[c];
    if (dB > 0) {
      lines.push(`+${dB} ${c} bonus (now ${afterMe.bonuses[c]}).`);
    }
  }

  // 3. Noble claim.
  for (const n of claimedNobles) {
    lines.push(`Claims the ${nobleDescription(n)} noble (+${n.prestige} prestige).`);
  }

  // 4. Noble proximity gain on still-unclaimed nobles.
  for (const noble of after.nobles) {
    const beforeProg = COLORS.reduce(
      (s, c) => s + Math.min(beforeMe.bonuses[c], noble.requirement[c]),
      0,
    );
    const afterProg = COLORS.reduce(
      (s, c) => s + Math.min(afterMe.bonuses[c], noble.requirement[c]),
      0,
    );
    if (afterProg > beforeProg) {
      const maxNeed = COLORS.reduce((s, c) => s + noble.requirement[c], 0);
      lines.push(
        `Closer to the ${nobleDescription(noble)} noble (${afterProg}/${maxNeed} bonuses).`,
      );
    }
  }

  // 5. Newly affordable face-up cards (mostly useful for take/reserve where
  //    the immediate effect is buying power, not a card itself).
  const beforeAffordable = new Set<string>();
  const afterAffordable = new Set<string>();
  for (const tier of TIERS) {
    for (const slot of before.faceUp[tier]) {
      if (slot === null) continue;
      if (computePayment(slot, beforeMe) !== null) beforeAffordable.add(slot.id);
    }
    for (const slot of after.faceUp[tier]) {
      if (slot === null) continue;
      if (computePayment(slot, afterMe) !== null) afterAffordable.add(slot.id);
    }
  }
  let bestNew: Card | null = null;
  for (const tier of TIERS) {
    for (const slot of after.faceUp[tier]) {
      if (slot === null) continue;
      if (beforeAffordable.has(slot.id)) continue;
      if (!afterAffordable.has(slot.id)) continue;
      if (bestNew === null || slot.prestige > bestNew.prestige) bestNew = slot;
    }
  }
  if (bestNew !== null && bestNew.prestige > 0) {
    lines.push(
      `Now able to afford a T${bestNew.tier} card (${bestNew.prestige}p, +${bestNew.bonus}).`,
    );
  }

  // 6. Denied opponent buys. Compares which face-up cards opponents could
  //    afford in the before state but are gone (this player's buy/reserve
  //    removed them) in the after state.
  for (let i = 0; i < before.players.length; i++) {
    if (i === me) continue;
    const beforeOpp = before.players[i];
    if (beforeOpp === undefined) continue;
    let deniedPrestige = 0;
    for (const tier of TIERS) {
      for (let slot = 0; slot < before.faceUp[tier].length; slot++) {
        const card = before.faceUp[tier][slot];
        if (card === null || card === undefined) continue;
        const stillThere = after.faceUp[tier][slot]?.id === card.id;
        if (stillThere) continue;
        if (computePayment(card, beforeOpp) !== null) {
          deniedPrestige += card.prestige;
        }
      }
    }
    if (deniedPrestige > 0) {
      lines.push(
        `Denies ${playerLabel(i)} a face-up buy worth ${deniedPrestige} prestige.`,
      );
    }
  }

  // 7. Reserve-specific notes (the gold and the held card aren't covered
  //    above because reserves don't directly change bonuses/prestige).
  if (action.type === 'reserve') {
    if (action.source.kind === 'faceUp') {
      const card = before.faceUp[action.source.tier][action.source.slot];
      if (card !== null && card !== undefined) {
        lines.push(
          `Holds the T${card.tier} card (${card.prestige}p, +${card.bonus}) in reserve for later.`,
        );
      }
    } else {
      lines.push(`Holds an unknown T${action.source.tier} card in reserve (drawn blind).`);
    }
    if (afterMe.gems.gold > beforeMe.gems.gold) {
      lines.push(`+1 gold wildcard (substitutes for any color when buying).`);
    }
  }

  return lines;
};

// Returns 1-3 generalizable Splendor lessons tied to the recommended action.
// These are about *strategy* (why this kind of move is generally good),
// not the immediate concrete consequences (which `explainAction` covers).
const strategicNotes = (
  before: GameState,
  after: GameState,
  me: PlayerIndex,
  action: Action,
): string[] => {
  const notes: string[] = [];
  const beforeMe = before.players[me];
  const afterMe = after.players[me];
  if (beforeMe === undefined || afterMe === undefined) return notes;

  switch (action.type) {
    case 'take3':
      notes.push(
        'Take-3 is the workhorse move: maximum gem variety per turn. Prefer it when you can spend the gems toward a real target within 1-2 turns — gems sitting in hand past the 10-cap are wasted.',
      );
      break;
    case 'take2':
      notes.push(
        'Take-2-same commits to a color. It is strongest when the supply pile is at 4+ (so opponents cannot deny it) and you already see a card whose cost concentrates that color.',
      );
      break;
    case 'reserve':
      notes.push(
        'Reserve gives you 1 gold — the wildcard that substitutes for any missing color. Use reserves to (a) lock a high-prestige T3 card you cannot yet afford or (b) deny a card an opponent is about to buy.',
      );
      break;
    case 'buy': {
      let card: Card | null = null;
      if (action.source.kind === 'faceUp') {
        card = before.faceUp[action.source.tier][action.source.slot] ?? null;
      } else {
        card = beforeMe.reserved[action.source.index]?.card ?? null;
      }
      if (card !== null) {
        if (card.tier === 1) {
          notes.push(
            'Tier-1 buys are engine work: the bonus is permanent, so every future card costing that color costs one fewer gem. Cheap T1s pay for themselves within 2-3 turns.',
          );
        } else if (card.tier === 2) {
          notes.push(
            'Tier-2 cards score AND extend the engine. They are usually the best prestige-per-turn after you have 3-4 T1 bonuses to pay for them.',
          );
        } else if (card.tier === 3) {
          notes.push(
            'Every T3 card is an "anchor": typically needs 5+ of one color in cost. Plan T1/T2 buys to feed those colors instead of spreading bonuses thinly.',
          );
        }
      }
      const claimedNoble = before.nobles.find((n) => !after.nobles.some((x) => x.id === n.id));
      if (claimedNoble !== undefined) {
        notes.push(
          'Claimed a noble — free +3 prestige. Nobles reward concentration: build the same color pair across multiple cards rather than one of everything.',
        );
      } else {
        let advancedNoble = false;
        for (const noble of after.nobles) {
          const beforeProg = COLORS.reduce(
            (s2, c) => s2 + Math.min(beforeMe.bonuses[c], noble.requirement[c]),
            0,
          );
          const afterProg = COLORS.reduce(
            (s2, c) => s2 + Math.min(afterMe.bonuses[c], noble.requirement[c]),
            0,
          );
          if (afterProg > beforeProg) {
            advancedNoble = true;
            break;
          }
        }
        if (advancedNoble) {
          notes.push(
            'This buy advances a noble. Nobles auto-trigger at the end of your turn — a noble worth +3 can flip a tight endgame.',
          );
        }
      }
      break;
    }
  }
  return notes;
};

// =============================================================================
// Component
// =============================================================================

const MAX_HISTORY = 20;

export default function AssistantApp() {
  const [s, setS] = useState<AssistantState>(initialState);
  const [history, setHistory] = useState<AssistantState[]>([]);
  const [thinking, setThinking] = useState(false);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [noblePickerOpen, setNoblePickerOpen] = useState(false);
  // When the main player reserves blindly from a deck, MCTS used an engine-
  // chosen guess for the card identity — but the user actually saw the card.
  // We open a picker after the reserve action so they can record the real
  // identity, replacing the guess so subsequent recommendations are sound.
  const [pendingBlindReserveTier, setPendingBlindReserveTier] =
    useState<Tier | null>(null);
  // When a turn auto-awards a noble but the player was eligible for
  // multiple, hold the post-apply state and the alternatives so the user
  // can swap before commit. apply() picks the first qualifying noble in
  // order; rare but worth honouring the player's choice.
  const [pendingNobleChoice, setPendingNobleChoice] = useState<{
    claimerIdx: number;
    autoAwarded: Noble;
    alternatives: Noble[];
    nextState: GameState;
    seenIds: string[];
  } | null>(null);
  // Simulation: engine plays both sides. simRunning is the play/pause
  // state; simSpeedMs is the per-step delay (slider). Reset to defaults
  // on app load — not persisted.
  const [simRunning, setSimRunning] = useState(false);
  const [simSpeedMs, setSimSpeedMs] = useState(1200);

  const pushHistory = (prev: AssistantState) => {
    setHistory((h) => [prev, ...h].slice(0, MAX_HISTORY));
  };
  const onUndo = () => {
    setHistory((h) => {
      const [head, ...rest] = h;
      if (head === undefined) return h;
      setS(head);
      setRecommendation(null);
      setErrors([]);
      return rest;
    });
  };

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }, [s]);

  // ===== Setters helpers =====

  const setNumPlayers = (n: 2 | 3 | 4) => {
    setS((prev) => {
      const players = prev.players.slice();
      while (players.length < n) players.push(emptyPlayer());
      return {
        ...prev,
        numPlayers: n,
        currentPlayer: (Math.min(prev.currentPlayer, n - 1) as PlayerIndex),
        mainPlayer: (Math.min(prev.mainPlayer, n - 1) as PlayerIndex),
        gemSupply: { ...GEM_SUPPLY_DEFAULT[n] },
        players,
      };
    });
  };

  const setMainPlayer = (idx: PlayerIndex) => {
    setS((prev) => ({ ...prev, mainPlayer: idx }));
  };

  const setPlayerName = (idx: number, name: string) => {
    setS((prev) => {
      const names = prev.playerNames.slice();
      while (names.length <= idx) names.push('');
      names[idx] = name;
      return { ...prev, playerNames: names };
    });
  };

  // Returns the user-set name for a seat, or the default "P0"/"P1"/etc.
  const playerLabel = (idx: number): string => {
    const name = s.playerNames[idx];
    return name !== undefined && name.trim().length > 0
      ? name.trim()
      : defaultPlayerName(idx);
  };

  // Replace "P{n}" tokens in a narration string with the user-set names.
  // Used to convert engine-side action descriptions ("T0 P0 buy ...") into
  // user-friendly ones ("T0 Alice buy ..."). Whole-word boundary on the
  // index so "P10" wouldn't get mangled (though we cap at 4 players anyway).
  const namifyNarration = (raw: string): string => {
    let out = raw;
    for (let i = 0; i < s.numPlayers; i++) {
      const name = s.playerNames[i];
      if (name === undefined || name.trim().length === 0) continue;
      out = out.replace(new RegExp(`\\bP${i}\\b`, 'g'), name.trim());
    }
    return out;
  };

  const toggleNoble = (n: Noble) => {
    setS((prev) => {
      const exists = prev.nobles.some((x) => x.id === n.id);
      const nobles = exists
        ? prev.nobles.filter((x) => x.id !== n.id)
        : [...prev.nobles, n].slice(0, prev.numPlayers + 1);
      return { ...prev, nobles };
    });
  };

  const setCurrentPlayer = (idx: PlayerIndex) => {
    setS((prev) => ({ ...prev, currentPlayer: idx }));
  };

  const resetGame = () => {
    if (!window.confirm('Start a new game? This clears all entered cards, nobles, gems, and player tableaus.')) {
      return;
    }
    setS((prev) => ({
      numPlayers: prev.numPlayers,
      currentPlayer: 0,
      startingPlayer: 0,
      turnNumber: 0,
      mainPlayer: prev.mainPlayer,
      playerNames: prev.playerNames.slice(),
      gemSupply: { ...GEM_SUPPLY_DEFAULT[prev.numPlayers] },
      faceUp: emptyFaceUp(),
      nobles: [],
      players: Array.from({ length: prev.numPlayers }, emptyPlayer),
      seenIds: [],
    }));
    setRecommendation(null);
    setErrors([]);
    setSimRunning(false);
  };

  /**
   * Build an AssistantState pre-populated as a freshly-dealt game: 4 face-up
   * cards per tier, numPlayers+1 nobles, default gem supply, no purchases.
   * Used by the sim controls so the user doesn't have to click in every
   * starting card manually.
   */
  const buildFreshAssistantState = (
    numPlayers: 2 | 3 | 4,
    mainPlayer: PlayerIndex,
    playerNames: string[],
  ): AssistantState => {
    const fresh = freshGameState(numPlayers, {
      rng: seededRng(Date.now() & 0xffff_ffff),
    });
    const seen = new Set<string>();
    for (const tier of TIERS) for (const c of fresh.faceUp[tier]) if (c !== null) seen.add(c.id);
    return {
      numPlayers,
      currentPlayer: 0,
      startingPlayer: 0,
      turnNumber: 0,
      mainPlayer,
      playerNames: playerNames.slice(),
      gemSupply: { ...fresh.gemSupply },
      faceUp: {
        1: fresh.faceUp[1].slice(),
        2: fresh.faceUp[2].slice(),
        3: fresh.faceUp[3].slice(),
      },
      nobles: fresh.nobles.slice(),
      players: Array.from({ length: numPlayers }, emptyPlayer),
      seenIds: Array.from(seen),
    };
  };

  // ===== Validation =====

  const validate = (): string[] => {
    const issues: string[] = [];
    const emptySlots: string[] = [];
    for (const tier of TIERS) {
      const deckHasCards = tierDeckRemaining(s, tier).length > 0;
      // An empty face-up slot is only a problem if there's a card waiting to
      // be revealed for it. If the tier deck is exhausted, the slot is
      // supposed to stay empty (standard Splendor rules).
      if (!deckHasCards) continue;
      for (let slot = 0; slot < s.faceUp[tier].length; slot++) {
        if (s.faceUp[tier][slot] === null) {
          emptySlots.push(`T${tier} slot ${slot + 1}`);
        }
      }
    }
    if (emptySlots.length > 0) {
      issues.push(
        emptySlots.length === 1
          ? `Fill the empty face-up slot (${emptySlots[0]}) before the assistant can recommend.`
          : `${emptySlots.length} face-up slots are empty — fill them before the assistant can recommend.`,
      );
    }
    if (s.nobles.length === 0) {
      issues.push('No nobles entered on the board.');
    }
    return issues;
  };

  // ===== Recommend =====

  /**
   * Shared MCTS runner used by both the manual "Recompute" button and the
   * auto-recommend effect. iterations is parameterised: manual runs use
   * the higher 500 for a more confident pick; auto-recommend uses 300 so
   * the brief UI freeze per state edit is shorter.
   */
  const runMcts = async (iterations: number) => {
    const issues = validate();
    setErrors(issues);
    setRecommendation(null);
    // If the board is invalid (typically: an empty face-up slot after a buy
    // or reserve) we must not recommend — the engine would optimise against
    // a counterfactual game state. The user sees the validation issue
    // instead and is prompted to enter the revealed card.
    if (issues.length > 0) {
      setThinking(false);
      return;
    }
    setThinking(true);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the spinner render
    try {
      const state = buildGameState(s);
      const start = Date.now();
      const stats = mctsBestActionWithStats(state, {
        iterations,
        evalFn: evaluateV3,
        rng: seededRng(Date.now() & 0xffff_ffff),
      });
      const summary = describeAction(state, stats.bestAction);
      // Compute the explanation by simulating the recommended action one ply
      // forward and diffing the before/after states. Wrapped in try/catch
      // because `apply` could theoretically throw if state drifted between
      // legalActions and now; in that case we just skip the panel.
      let explanation: string[] = [];
      let strategy: string[] = [];
      try {
        const afterBest = apply(state, stats.bestAction);
        explanation = explainAction(
          state,
          afterBest,
          state.currentPlayer,
          stats.bestAction,
          playerLabel,
        );
        strategy = strategicNotes(
          state,
          afterBest,
          state.currentPlayer,
          stats.bestAction,
        );
      } catch {
        /* leave explanation/strategy empty */
      }
      const alternatives: Alternative[] = stats.candidates
        .slice(1, 5)
        .map((c: MctsCandidate) => ({
          action: c.action,
          summary: describeAction(state, c.action),
          visits: c.visits,
          meanReward: c.meanReward,
        }));
      setRecommendation({
        bestAction: stats.bestAction,
        summary,
        explanation,
        strategy,
        winRates: stats.winRates,
        currentPlayer: state.currentPlayer,
        rootVisits: stats.rootVisits,
        alternatives,
        thinkingMs: Date.now() - start,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors((cur) => [...cur, `Recommendation failed: ${message}`]);
    } finally {
      setThinking(false);
    }
  };

  /**
   * Apply an action to the engine and update the form to match the
   * resulting state. The face-up slot the action operated on is left
   * empty if the action was a buy or face-up reserve — the user fills
   * the revealed card via the existing picker.
   *
   * Saves the current form state to history so the user can undo.
   */
  // Compute seenIds after applying — adds every face-up card and every
  // reserved card that's visible to us. Idempotent.
  const collectSeen = (next: GameState, prev: string[]): string[] => {
    const seen = new Set(prev);
    for (const p of next.players) {
      for (const r of p.reserved) seen.add(r.card.id);
    }
    for (const tier of TIERS) {
      for (const c of next.faceUp[tier]) {
        if (c !== null) seen.add(c.id);
      }
    }
    return Array.from(seen);
  };

  /**
   * If applying the action just auto-awarded a noble AND the claimer would
   * have qualified for at least one other noble on the board, returns
   * the pending-choice payload so the UI can prompt. Otherwise null.
   */
  const detectMultiNobleChoice = (
    pre: GameState,
    post: GameState,
    seenIds: string[],
  ): typeof pendingNobleChoice => {
    const claimerIdx = pre.currentPlayer;
    const claimed = pre.nobles.find((n) => !post.nobles.some((x) => x.id === n.id));
    if (claimed === undefined) return null;
    const claimer = post.players[claimerIdx];
    if (claimer === undefined) return null;
    const alternatives = pre.nobles.filter(
      (n) => n.id !== claimed.id && meetsNobleRequirement(claimer.bonuses, n.requirement),
    );
    if (alternatives.length === 0) return null;
    return {
      claimerIdx,
      autoAwarded: claimed,
      alternatives,
      nextState: post,
      seenIds,
    };
  };

  const commitApplied = (next: GameState, seenIds: string[]) => {
    setS((prev) => ({
      ...fromGameState(next, prev),
      seenIds,
    }));
    setRecommendation(null);
    setErrors([]);
  };

  const onApply = (action: Action) => {
    try {
      const state = buildGameState(s);
      const next = apply(state, action);
      pushHistory(s);
      const seen = collectSeen(next, s.seenIds);
      const choice = detectMultiNobleChoice(state, next, seen);
      if (choice !== null) {
        setPendingNobleChoice(choice);
        return; // wait for the user to resolve
      }
      commitApplied(next, seen);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors([`Apply failed: ${message}`]);
    }
  };

  /**
   * Resolve a pending multi-noble choice. If the user picks a different
   * noble than the engine auto-awarded, swap: put the auto-awarded back on
   * the board and take the chosen one. All nobles in the base game are
   * worth +3 prestige so the prestige delta is unchanged.
   */
  const onResolveNobleChoice = (chosen: Noble) => {
    if (pendingNobleChoice === null) return;
    const { claimerIdx, autoAwarded, nextState, seenIds } = pendingNobleChoice;
    let finalState = nextState;
    if (chosen.id !== autoAwarded.id) {
      // Deep-ish copy of the bits we mutate so we don't pollute the
      // captured nextState (it might still be referenced by closures).
      const players = nextState.players.slice();
      const target = players[claimerIdx];
      if (target !== undefined) {
        const updatedNobles = target.nobles
          .filter((n) => n.id !== autoAwarded.id)
          .concat([chosen]);
        players[claimerIdx] = { ...target, nobles: updatedNobles };
      }
      const boardNobles = nextState.nobles
        .filter((n) => n.id !== chosen.id)
        .concat([autoAwarded]);
      finalState = { ...nextState, players, nobles: boardNobles };
    }
    commitApplied(finalState, seenIds);
    setPendingNobleChoice(null);
  };

  /**
   * Applies an action that came from the engine's recommendation (whether
   * for the main player or via the "Suggest" button for an opponent). The
   * user is effectively playing both sides at that point — they know every
   * card the engine is reasoning about. So a blind reserve from the deck
   * must be identified before commit; otherwise the engine guesses and the
   * "blind" player would be running on stale info.
   *
   * Manual opponent-picker entries still go through plain onApply, where
   * blind reserves stay genuinely unknown.
   */
  const applyRecommendation = (action: Action) => {
    if (action.type === 'reserve' && action.source.kind === 'deck') {
      setPendingBlindReserveTier(action.source.tier);
      return;
    }
    onApply(action);
  };

  /**
   * One simulation tick: run MCTS for the current player and commit the
   * recommended action, bypassing all user-prompt intercepts (blind
   * reserves use the engine guess, multi-noble auto-takes the first
   * eligible). Returns true if a step was taken, false if the game has
   * ended or there's nothing legal to do.
   */
  const simStepOnce = (): boolean => {
    const state = buildGameState(s);
    if (isTerminal(state)) return false;
    try {
      const stats = mctsBestActionWithStats(state, {
        iterations: 300,
        evalFn: evaluateV3,
        rng: seededRng(Date.now() & 0xffff_ffff),
      });
      // apply() leaves emptied face-up slots as null + queues a reveal in
      // `pendingReveals`. In manual play the user enters the revealed card;
      // in sim mode we drive both sides ourselves, so resolve all pending
      // reveals automatically (deterministic — top of the synthetic deck).
      const next = applyAllReveals(apply(state, stats.bestAction));
      pushHistory(s);
      const seen = collectSeen(next, s.seenIds);
      commitApplied(next, seen);
      return true;
    } catch (err) {
      setErrors([`Sim step failed: ${err instanceof Error ? err.message : String(err)}`]);
      setSimRunning(false);
      return false;
    }
  };

  /**
   * Replace state with a freshly-dealt position (4 face-up cards per tier,
   * numPlayers+1 nobles, default supply). Use as a starting point for
   * playing manually or as the seed for a simulation.
   */
  const setupFreshDeal = () => {
    setS((prev) => buildFreshAssistantState(prev.numPlayers, prev.mainPlayer, prev.playerNames));
    setRecommendation(null);
    setErrors([]);
    setSimRunning(false);
  };

  /**
   * Deal a fresh game and immediately start auto-play.
   */
  const startSimFromFresh = () => {
    setS((prev) => buildFreshAssistantState(prev.numPlayers, prev.mainPlayer, prev.playerNames));
    setRecommendation(null);
    setErrors([]);
    setSimRunning(true);
  };

  // Commit a recommendation-sourced blind reserve once the user has
  // identified the drawn card. We apply the reserve as if `kind: 'deck'`,
  // then overwrite the engine's guessed identity with the user's actual
  // card and clear the blind flag on that entry.
  const onConfirmBlindReserve = (actualCard: Card) => {
    const tier = pendingBlindReserveTier;
    if (tier === null) return;
    try {
      const state = buildGameState(s);
      const next = apply(state, { type: 'reserve', source: { kind: 'deck', tier } });
      const reserverIdx = state.currentPlayer;
      const reservedList = next.players[reserverIdx]?.reserved;
      if (reservedList && reservedList.length > 0) {
        const lastEntry = reservedList[reservedList.length - 1];
        if (lastEntry !== undefined) {
          reservedList[reservedList.length - 1] = {
            ...lastEntry,
            card: actualCard,
          };
        }
      }
      pushHistory(s);
      const seen = new Set(s.seenIds);
      for (const p of next.players) {
        for (const r of p.reserved) seen.add(r.card.id);
      }
      for (const t of TIERS) {
        for (const c of next.faceUp[t]) {
          if (c !== null) seen.add(c.id);
        }
      }
      setS((prev) => {
        const form = fromGameState(next, prev);
        // The just-reserved entry is reservedFrom='deck' so fromGameState
        // marks it blind. For the main player this is wrong — they saw
        // the card, so clear blind on the last reserved entry.
        const players = form.players.slice();
        const target = players[reserverIdx];
        if (target !== undefined && target.reserved.length > 0) {
          const reserved = target.reserved.slice();
          const last = reserved[reserved.length - 1];
          if (last !== undefined) {
            reserved[reserved.length - 1] = { card: last.card };
            players[reserverIdx] = { ...target, reserved };
          }
        }
        return { ...form, players, seenIds: Array.from(seen) };
      });
      setRecommendation(null);
      setErrors([]);
      setPendingBlindReserveTier(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors([`Apply failed: ${message}`]);
      setPendingBlindReserveTier(null);
    }
  };

  // ===== Derived state used by effects + render =====

  // Engine-shape state, used by ActionSummary to resolve faceUp sources
  // for the recommendation/alternatives display, and by the terminal checks.
  // Safe to use the current assistantState because recommendation is
  // cleared on any state change.
  const engineState = useMemo(() => buildGameState(s), [s]);

  // End-of-round terminality: someone hit 15 prestige AND we've wrapped
  // back to the starting seat (every player got an equal number of turns).
  const gameOver = useMemo(() => isTerminal(engineState), [engineState]);
  const gameWinner = useMemo(
    () => (gameOver ? winner(engineState) : null),
    [gameOver, engineState],
  );
  // "Game ending after this round" warning while at least one player is at
  // 15+ but we haven't wrapped to startingPlayer yet.
  const gameEndingSoon = useMemo(
    () =>
      !gameOver
      && engineState.turnNumber > 0
      && engineState.players.some((p) => p.prestige >= 15),
    [gameOver, engineState],
  );

  // ===== Auto-recommend =====

  const stateForEffect = s; // explicit so the effect can depend on the whole object
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Cancel any pending auto-run if state changed mid-debounce.
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // Game's done — no more recommendations.
    if (gameOver) {
      setRecommendation(null);
      return;
    }
    // Sim is driving — don't fight it with the auto-recommend.
    if (simRunning) {
      return;
    }
    // Not the main player's turn — clear any stale recommendation.
    if (stateForEffect.currentPlayer !== stateForEffect.mainPlayer) {
      setRecommendation(null);
      return;
    }
    // Validation must pass before we burn cycles on a doomed run.
    const issues = validate();
    if (issues.length > 0) return;
    debounceRef.current = setTimeout(() => {
      void runMcts(300);
    }, 900);
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runMcts / validate close over s
  }, [
    stateForEffect.currentPlayer,
    stateForEffect.mainPlayer,
    stateForEffect.gemSupply,
    stateForEffect.faceUp,
    stateForEffect.nobles,
    stateForEffect.players,
    stateForEffect.numPlayers,
    simRunning,
    gameOver,
  ]);

  // ===== Sim auto-step loop =====
  //
  // When simRunning is true, schedule one step per simSpeedMs. The effect
  // re-fires after each commit (state changes → s changes), scheduling the
  // next step. Stops on game over or error.
  const simTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (simTimeoutRef.current !== null) {
      clearTimeout(simTimeoutRef.current);
      simTimeoutRef.current = null;
    }
    if (!simRunning) return;
    if (gameOver) {
      setSimRunning(false);
      return;
    }
    simTimeoutRef.current = setTimeout(() => {
      simStepOnce();
    }, simSpeedMs);
    return () => {
      if (simTimeoutRef.current !== null) {
        clearTimeout(simTimeoutRef.current);
        simTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- simStepOnce closes over s
  }, [simRunning, simSpeedMs, gameOver, stateForEffect]);

  // ===== Render helpers =====

  // Card IDs no longer in the deck (ever placed face-up, currently reserved,
  // or already purchased by anyone). The picker uses this to grey out cards
  // that can't legally be revealed again — seenIds is exactly this set.
  const usedCardIds = useMemo(() => new Set(s.seenIds), [s.seenIds]);


  /**
   * Normalized "share of likely wins" per player.
   *
   * MCTS stores totalReward[i]/visits, which for terminal-only rollouts sums
   * to 1.0 (one winner per game). With non-terminal rollouts (the common
   * case mid-game) each player's reward is a *squashed* evaluator score in
   * [0, 1] — both players can saturate near 1 if both positions look good,
   * which is why two players showed 96% each pre-fix. Dividing by the sum
   * converts the raw scores into a proper "of these candidate winners,
   * which one?" share that adds to 100%.
   *
   * Falls back to a flat distribution when MCTS hasn't given us anything.
   */
  const winShares: number[] | undefined = useMemo(() => {
    if (recommendation === null) return undefined;
    const raw = recommendation.winRates;
    const sum = raw.reduce((a, b) => a + b, 0);
    if (sum <= 0) return raw.map(() => 1 / raw.length);
    return raw.map((r) => r / sum);
  }, [recommendation]);

  // Which face-up slot (if any) the current recommendation points at. Drives
  // the highlight ring on CardSlot so the user can see exactly which card
  // the engine wants them to buy/reserve.
  const highlightedFaceUp: { tier: Tier; slot: number } | null = useMemo(() => {
    if (recommendation === null) return null;
    const a = recommendation.bestAction;
    if (a.type === 'buy' && a.source.kind === 'faceUp') {
      return { tier: a.source.tier, slot: a.source.slot };
    }
    if (a.type === 'reserve' && a.source.kind === 'faceUp') {
      return { tier: a.source.tier, slot: a.source.slot };
    }
    return null;
  }, [recommendation]);

  // Mirror of highlightedFaceUp for "buy from your reserved pile" — same
  // disambiguation problem when two reserves share a bonus color. Drives
  // PlayerPanel to force-open its reserved drawer and pulse the matching
  // entry.
  const highlightedReserved: { playerIdx: number; index: number } | null = useMemo(() => {
    if (recommendation === null) return null;
    const a = recommendation.bestAction;
    if (a.type === 'buy' && a.source.kind === 'reserve') {
      return { playerIdx: recommendation.currentPlayer, index: a.source.index };
    }
    return null;
  }, [recommendation]);

  // ===== Render =====

  const currentVisibleFaceUp = (tier: Tier) =>
    s.faceUp[tier].filter((c) => c !== null).length;

  return (
    <div className="assistant">
      <header>
        <div className="header-row">
          <h1>Splendor Assistant</h1>
          <div className="field">
            <label>Players</label>
            <div className="pill-row">
              {[2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`pill ${s.numPlayers === n ? 'active' : ''}`}
                  onClick={() => setNumPlayers(n as 2 | 3 | 4)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Turn</label>
            <div className="pill-row">
              {Array.from({ length: s.numPlayers }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`pill ${s.currentPlayer === i ? 'active' : ''}`}
                  onClick={() => setCurrentPlayer(i as PlayerIndex)}
                >
                  {playerLabel(i)}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>You</label>
            <div className="pill-row">
              {Array.from({ length: s.numPlayers }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`pill ${s.mainPlayer === i ? 'active' : ''}`}
                  onClick={() => setMainPlayer(i as PlayerIndex)}
                >
                  {playerLabel(i)}
                </button>
              ))}
            </div>
          </div>
          <div className="sim-controls" title="Engine plays both sides">
            <button
              type="button"
              className="sim-btn sim-toggle"
              onClick={() => {
                if (simRunning) {
                  setSimRunning(false);
                  return;
                }
                // If the board is blank (turnNumber=0 and no nobles), deal
                // a fresh game first; otherwise resume from where we are.
                if (s.turnNumber === 0 && s.nobles.length === 0) {
                  startSimFromFresh();
                } else {
                  setSimRunning(true);
                }
              }}
              disabled={gameOver}
              aria-label={simRunning ? 'Pause simulation' : 'Run simulation'}
            >
              {simRunning ? '⏸' : '▶'} Sim
            </button>
            <button
              type="button"
              className="sim-btn"
              onClick={simStepOnce}
              disabled={simRunning || gameOver}
              title="Apply the engine's recommended action for the current player"
            >
              Step
            </button>
            <div className="sim-speed">
              <span className="sim-speed-label">slow</span>
              <input
                type="range"
                min="200"
                max="3000"
                step="100"
                value={3200 - simSpeedMs}
                onChange={(e) => setSimSpeedMs(3200 - Number(e.target.value))}
                aria-label="Simulation speed"
              />
              <span className="sim-speed-label">fast</span>
            </div>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="undo-btn"
              onClick={onUndo}
              disabled={history.length === 0}
              title={history.length === 0 ? 'Nothing to undo' : 'Restore the previous state'}
            >
              ↶
            </button>
            <button
              type="button"
              className="setup-btn"
              onClick={setupFreshDeal}
              title="Deal 4 face-up cards per tier and numPlayers+1 nobles at random — no auto-play"
            >
              🎲 Setup
            </button>
            <button type="button" className="new-game-btn" onClick={resetGame}>
              New game
            </button>
          </div>
        </div>
      </header>

      <div className="body-grid">
      <div className="board-col">
      <section className="card">
        <h2>Gem supply</h2>
        <div className="readonly-row">
          {GEM_COLORS.map((c) => (
            <div
              key={c}
              className="readonly-cell"
              title={`${c} supply`}
              aria-label={`gem supply ${c}: ${s.gemSupply[c]}`}
            >
              <span
                className="swatch gem"
                style={{ background: c === 'gold' ? GOLD_HEX : COLOR_HEX[c] }}
              />
              <span className="readonly-num">{s.gemSupply[c]}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Face-up cards</h2>
        {TIERS.slice().reverse().map((tier) => (
          <div key={tier} className="faceup-row tier-row">
            <span className="faceup-label">T{tier}</span>
            <div className="faceup-tiles">
              {s.faceUp[tier].map((card, i) => (
                <CardSlot
                  key={i}
                  tier={tier}
                  card={card}
                  unavailableIds={usedCardIds}
                  highlighted={
                    highlightedFaceUp !== null
                    && highlightedFaceUp.tier === tier
                    && highlightedFaceUp.slot === i
                  }
                  onPick={(picked) => {
                    setS((prev) => {
                      const grid = { ...prev.faceUp, [tier]: prev.faceUp[tier].slice() };
                      const prevCard = prev.faceUp[tier][i];
                      grid[tier][i] = picked;
                      // Maintain seenIds: adding a card → record it; clearing
                      // a slot manually → treat as correction and un-record
                      // the previously-occupying card (so it can be re-picked).
                      const seen = new Set(prev.seenIds);
                      if (picked !== null) seen.add(picked.id);
                      else if (prevCard !== null && prevCard !== undefined) seen.delete(prevCard.id);
                      return { ...prev, faceUp: grid, seenIds: Array.from(seen) };
                    });
                  }}
                />
              ))}
            </div>
            <span className="faceup-count">
              {currentVisibleFaceUp(tier)} / 4
              <span className="deck-left">
                · deck {tierDeckRemaining(s, tier).length}
              </span>
            </span>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Nobles ({s.nobles.length}/{s.numPlayers + 1})</h2>
        <div className="noble-grid">
          {s.nobles.map((n) => (
            <button
              key={n.id}
              type="button"
              className="noble-tile selected"
              onClick={() => toggleNoble(n)}
              title={`Remove ${describeNobleRequirement(n)}`}
              aria-label={`Remove noble requiring ${describeNobleRequirement(n)}`}
            >
              <NobleArt noble={n} size="small" />
            </button>
          ))}
          {s.nobles.length < s.numPlayers + 1 && (
            <button
              type="button"
              className="noble-add-btn"
              onClick={() => setNoblePickerOpen(true)}
              aria-label="Add a noble"
            >
              + add
            </button>
          )}
        </div>
        {noblePickerOpen && (
          <NoblePickerModal
            unavailableIds={new Set(s.nobles.map((n) => n.id))}
            onPick={(picked) => {
              if (picked !== null) toggleNoble(picked);
              setNoblePickerOpen(false);
            }}
            onClose={() => setNoblePickerOpen(false)}
          />
        )}
        {pendingBlindReserveTier !== null && (
          <CardPickerModal
            tier={pendingBlindReserveTier}
            selected={null}
            unavailableIds={usedCardIds}
            title={
              s.currentPlayer === s.mainPlayer
                ? `Which T${pendingBlindReserveTier} card did you draw?`
                : `Which T${pendingBlindReserveTier} card did ${playerLabel(s.currentPlayer)} draw?`
            }
            onPick={(picked) => {
              if (picked !== null) onConfirmBlindReserve(picked);
              else setPendingBlindReserveTier(null);
            }}
            onClose={() => setPendingBlindReserveTier(null)}
          />
        )}
        {pendingNobleChoice !== null && (
          <NobleChoiceModal
            claimerName={playerLabel(pendingNobleChoice.claimerIdx)}
            autoAwarded={pendingNobleChoice.autoAwarded}
            alternatives={pendingNobleChoice.alternatives}
            onPick={onResolveNobleChoice}
          />
        )}
      </section>

      </div>
      <div className="side-col">
      <section className="card">
        <h2>Players</h2>
        {s.players.slice(0, s.numPlayers).map((p, idx) => (
          <PlayerPanel
            key={idx}
            idx={idx}
            name={s.playerNames[idx] ?? ''}
            isCurrent={idx === s.currentPlayer}
            player={p}
            unavailableIds={usedCardIds}
            winRate={winShares?.[idx]}
            qualifyingNobles={s.nobles.filter((n) =>
              meetsNobleRequirement(p.bonuses, n.requirement),
            )}
            highlightReservedIndex={
              highlightedReserved !== null && highlightedReserved.playerIdx === idx
                ? highlightedReserved.index
                : undefined
            }
            onName={(name) => setPlayerName(idx, name)}
            onReservedAdd={(card) =>
              setS((prev) => {
                const players = prev.players.slice();
                const target = players[idx];
                if (target === undefined) return prev;
                if (target.reserved.length >= 3) return prev;
                players[idx] = {
                  ...target,
                  reserved: [...target.reserved, { card }],
                };
                const seen = new Set(prev.seenIds);
                seen.add(card.id);
                return { ...prev, players, seenIds: Array.from(seen) };
              })
            }
            onReservedRemove={(i) =>
              setS((prev) => {
                const players = prev.players.slice();
                const target = players[idx];
                if (target === undefined) return prev;
                const reserved = target.reserved.slice();
                const removed = reserved[i];
                reserved.splice(i, 1);
                players[idx] = { ...target, reserved };
                // Manual remove = correction; let the card be re-picked.
                const seen = new Set(prev.seenIds);
                if (removed !== undefined) seen.delete(removed.card.id);
                return { ...prev, players, seenIds: Array.from(seen) };
              })
            }
          />
        ))}
      </section>

      <section className="card recommend">
        {gameOver && gameWinner !== null && (
          <div className="game-over-banner">
            <div className="game-over-title">🏆 Game over</div>
            <div className="game-over-sub">
              <strong>{playerLabel(gameWinner)}</strong> wins with{' '}
              {engineState.players[gameWinner]?.prestige ?? 0} prestige
              {' '}({engineState.players[gameWinner]?.purchased.length ?? 0} cards).
              Tiebreaker: fewest purchased cards.
            </div>
          </div>
        )}
        {gameEndingSoon && (
          <div className="game-ending-banner">
            ⚠ Someone hit 15 prestige — game ends after this round (back to{' '}
            {playerLabel(s.startingPlayer)}).
          </div>
        )}
        {!gameOver && s.currentPlayer !== s.mainPlayer && (
          <OpponentTurnPanel
            assistantState={s}
            playerLabel={playerLabel}
            onApply={onApply}
            onSuggest={() => void runMcts(500)}
            thinking={thinking}
            errors={errors}
          />
        )}
        {!gameOver && s.currentPlayer === s.mainPlayer && (
          <>
            <div className="recommend-header">
              <strong>Your turn ({playerLabel(s.mainPlayer)})</strong>
              <div className="recommend-status">
                {thinking && <span className="thinking-indicator">Thinking…</span>}
                <button
                  type="button"
                  className="recompute-btn"
                  onClick={() => void runMcts(500)}
                  disabled={thinking}
                >
                  Recompute (deeper)
                </button>
              </div>
            </div>
            {errors.length > 0 && (
              <div className="issues">
                {errors.map((e, i) => (
                  <div key={i}>⚠ {e}</div>
                ))}
              </div>
            )}
          </>
        )}
        {recommendation && (
          <>
            {s.currentPlayer !== s.mainPlayer && (
              <div className="rec-for-opponent-label">
                Suggested for {playerLabel(recommendation.currentPlayer)} — clicking
                applies it as their move
              </div>
            )}
            <div className="recommendation">
              <button
                type="button"
                className="rec-option recommended"
                onClick={() => applyRecommendation(recommendation.bestAction)}
                disabled={thinking}
              >
                <div className="rec-option-left">
                  <span className="rec-option-tag">
                    {s.currentPlayer === s.mainPlayer ? 'Recommended' : 'Suggested'}
                  </span>
                  <span className="rec-option-summary">
                    <ActionSummary state={engineState} action={recommendation.bestAction} />
                  </span>
                </div>
                <span className="rec-option-cta">Click to apply →</span>
              </button>

                {recommendation.explanation.length > 0 && (
                  <div className="why">
                    <div className="why-title">Why this move</div>
                    <ul>
                      {recommendation.explanation.map((line, i) => (
                        <li key={i}>{namifyNarration(line)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {recommendation.strategy.length > 0 && (
                  <div className="strategy">
                    <div className="strategy-title">
                      Strategy — read these over time
                    </div>
                    {recommendation.strategy.map((para, i) => (
                      <p key={i}>{para}</p>
                    ))}
                  </div>
                )}

                {recommendation.alternatives.length > 0 && (
                  <details className="alternatives">
                    <summary className="alt-title">
                      Or pick a different move ({recommendation.alternatives.length})
                    </summary>
                    {recommendation.alternatives.map((a, i) => (
                      <button
                        key={i}
                        type="button"
                        className="rec-option alt"
                        onClick={() => applyRecommendation(a.action)}
                        disabled={thinking}
                      >
                        <span className="rec-option-summary">
                          <ActionSummary state={engineState} action={a.action} />
                        </span>
                        <span className="alt-meta">
                          {(a.meanReward * 100).toFixed(0)}% · {a.visits} visits
                        </span>
                      </button>
                    ))}
                  </details>
                )}

                <div className="rec-meta">
                  MCTS · {recommendation.rootVisits} iter · {recommendation.thinkingMs} ms
                </div>
              </div>
          </>
        )}
      </section>
      </div>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

const describeNobleRequirement = (n: Noble): string =>
  COLORS.filter((c) => n.requirement[c] > 0)
    .map((c) => `${n.requirement[c]} ${c}`)
    .join(' + ');

// =============================================================================
// Card visuals — used both as face-up slots and in the picker grid.
// =============================================================================

// Face-down placeholder for a card whose identity the user doesn't know
// (typically an opponent's blind reserve from the deck top). Same outline
// as CardArt so it fits next to face-up reserves without re-flow.
function BlindCardArt({ tier, size = 'normal' }: { tier: Tier; size?: 'normal' | 'small' }) {
  return (
    <div className={`card-art blind-art ${size === 'small' ? 'small' : ''} dark`}>
      <div className="blind-tier">T{tier}</div>
      <div className="blind-mark">?</div>
    </div>
  );
}

function NobleArt({ noble, size = 'normal' }: { noble: Noble; size?: 'normal' | 'small' }) {
  return (
    <div className={`card-art noble-art ${size === 'small' ? 'small' : ''} light`}>
      <div className="card-prestige">{noble.prestige}</div>
      <div className="card-cost">
        {COLORS.filter((c) => noble.requirement[c] > 0).map((c) => (
          <div key={c} className="card-cost-pip">
            <span className="cost-pip-swatch" style={{ background: COLOR_HEX[c] }} />
            <span className="cost-pip-num">{noble.requirement[c]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CardArt({ card, size = 'normal' }: { card: Card; size?: 'normal' | 'small' }) {
  const bg = COLOR_HEX[card.bonus];
  const dark = card.bonus !== 'white';
  return (
    <div
      className={`card-art ${size === 'small' ? 'small' : ''} ${dark ? 'dark' : 'light'}`}
      style={{ background: bg }}
    >
      <div className="card-prestige">{card.prestige > 0 ? card.prestige : ''}</div>
      <div className="card-cost">
        {COLORS.filter((c) => card.cost[c] > 0).map((c) => (
          <div key={c} className="card-cost-pip">
            <span className="cost-pip-swatch" style={{ background: COLOR_HEX[c] }} />
            <span className="cost-pip-num">{card.cost[c]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CardSlot({
  tier,
  card,
  onPick,
  unavailableIds,
  highlighted = false,
}: {
  tier: Tier;
  card: Card | null;
  onPick: (card: Card | null) => void;
  unavailableIds: Set<string>;
  highlighted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`card-slot ${card ? 'filled' : 'empty'} ${highlighted ? 'highlighted' : ''}`}
        onClick={() => setOpen(true)}
        aria-label={`face-up tier ${tier} slot ${card ? card.id : 'empty'}${highlighted ? ' (recommended)' : ''}`}
      >
        {card ? (
          <CardArt card={card} size="small" />
        ) : (
          <span className="slot-placeholder">+ T{tier}</span>
        )}
      </button>
      {open && (
        <CardPickerModal
          tier={tier}
          selected={card}
          unavailableIds={unavailableIds}
          onPick={(picked) => {
            onPick(picked);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CardPickerModal({
  tier,
  selected,
  unavailableIds,
  onPick,
  onClose,
  title,
}: {
  tier: Tier;
  selected: Card | null;
  unavailableIds: Set<string>;
  onPick: (card: Card | null) => void;
  onClose: () => void;
  title?: string;
}) {
  // Show only cards still in the deck (or the currently-selected card if any,
  // so the user can keep their existing pick). Sort by bonus colour, then by
  // prestige ascending, then by total cost — same order in every tier so the
  // black cards always live at the same end of the picker.
  const cards = useMemo(() => {
    const colorRank: Record<Color, number> = {
      white: 0, blue: 1, green: 2, red: 3, black: 4,
    };
    const totalCost = (c: Card) =>
      c.cost.white + c.cost.blue + c.cost.green + c.cost.red + c.cost.black;
    return ALL_CARDS
      .filter((c) => c.tier === tier)
      .filter((c) => !unavailableIds.has(c.id) || c.id === selected?.id)
      .sort((a, b) => {
        const r = colorRank[a.bonus] - colorRank[b.bonus];
        if (r !== 0) return r;
        const p = a.prestige - b.prestige;
        if (p !== 0) return p;
        return totalCost(a) - totalCost(b);
      });
  }, [tier, unavailableIds, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={`Pick a tier ${tier} card`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{title ?? `Tier ${tier} cards`}</h3>
          <div className="modal-actions">
            {selected && (
              <button type="button" className="modal-clear" onClick={() => onPick(null)}>
                Clear slot
              </button>
            )}
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body">
          <div className="picker-grid">
            {cards.map((c) => {
              const isSelected = selected?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`picker-tile ${isSelected ? 'selected' : ''}`}
                  onClick={() => onPick(c)}
                  title={c.id}
                >
                  <CardArt card={c} />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Shown when an action would qualify the actor for more than one noble.
// Engine auto-awarded the first in order; this lets the user override.
function NobleChoiceModal({
  claimerName,
  autoAwarded,
  alternatives,
  onPick,
}: {
  claimerName: string;
  autoAwarded: Noble;
  alternatives: Noble[];
  onPick: (chosen: Noble) => void;
}) {
  const all = [autoAwarded, ...alternatives];
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-label="Pick a noble to claim"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{claimerName} qualifies for {all.length} nobles — claim which?</h3>
        </div>
        <div className="modal-body">
          <div className="noble-grid">
            {all.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`noble-tile selected`}
                onClick={() => onPick(n)}
                title={`Claim noble (${COLORS.filter((c) => n.requirement[c] > 0).map((c) => `${n.requirement[c]} ${c}`).join(' + ')})`}
              >
                <NobleArt noble={n} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function NoblePickerModal({
  unavailableIds,
  onPick,
  onClose,
}: {
  unavailableIds: Set<string>;
  onPick: (noble: Noble | null) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Pick a noble"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Add noble</h3>
          <div className="modal-actions">
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body">
          <div className="picker-grid">
            {ALL_NOBLES.map((n) => {
              const isUnavailable = unavailableIds.has(n.id);
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`picker-tile ${isUnavailable ? 'unavailable' : ''}`}
                  onClick={() => { if (!isUnavailable) onPick(n); }}
                  disabled={isUnavailable}
                  title={isUnavailable ? 'Already on the board' : `Noble: ${COLORS.filter((c) => n.requirement[c] > 0).map((c) => `${n.requirement[c]} ${c}`).join(' + ')}`}
                >
                  <NobleArt noble={n} />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlayerPanel({
  idx,
  name,
  isCurrent,
  player,
  unavailableIds,
  winRate,
  qualifyingNobles,
  highlightReservedIndex,
  onName,
  onReservedAdd,
  onReservedRemove,
}: {
  idx: number;
  name: string;
  isCurrent: boolean;
  player: PlayerForm;
  unavailableIds: Set<string>;
  winRate: number | undefined;
  qualifyingNobles: Noble[];
  highlightReservedIndex: number | undefined;
  onName: (name: string) => void;
  onReservedAdd: (card: Card) => void;
  onReservedRemove: (i: number) => void;
}) {
  const [reservedOpen, setReservedOpen] = useState(false);
  // When the engine highlights one of our reserved cards (buy-from-reserve
  // recommendation), force the drawer open so the user can see which one
  // is being suggested without an extra click.
  const showReserved = reservedOpen || highlightReservedIndex !== undefined;
  // Running total of gems incl. gold. Hits GEM_HAND_LIMIT (10) → can't take
  // any more gems this turn; surface as a warning in the header.
  const gemTotal = GEM_COLORS.reduce((s, c) => s + player.gems[c], 0);
  const [addingReserved, setAddingReserved] = useState<Tier | null>(null);
  return (
    <div className={`player-panel ${isCurrent ? 'current' : ''}`}>
      <div className="player-header">
        <input
          type="text"
          className="player-name-input"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder={`P${idx}`}
          spellCheck={false}
          maxLength={24}
          aria-label={`Name for player ${idx}`}
        />
        {isCurrent && <span className="badge">to move</span>}
        {qualifyingNobles.length > 0 && (
          <span
            className="noble-qualify-pill"
            title={
              qualifyingNobles.length === 1
                ? `Qualifies for a noble (${describeNobleRequirement(qualifyingNobles[0]!)}) — claims it at end of turn`
                : `Qualifies for ${qualifyingNobles.length} nobles — can claim one per turn`
            }
          >
            👑 ×{qualifyingNobles.length}
          </span>
        )}
        {winRate !== undefined && (
          <span
            className="winchance-pill"
            title="Share of likely wins from the current MCTS recommendation (sums to 100% across players, not calibrated)"
          >
            {(Math.max(0, Math.min(1, winRate)) * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="player-stats">
        <span className="stat-label" title="Bonuses">B</span>
        {COLORS.map((c) => (
          <div
            key={`b-${c}`}
            className="readonly-cell"
            title={`${c} bonus: ${player.bonuses[c]}`}
            aria-label={`P${idx} bonus ${c}: ${player.bonuses[c]}`}
          >
            <span className="swatch" style={{ background: COLOR_HEX[c] }} />
            <span className="readonly-num">{player.bonuses[c]}</span>
          </div>
        ))}
        <span className="stats-sep" />
        <span className="stat-label" title="Gems">G</span>
        <span
          className={`gem-total ${gemTotal >= GEM_HAND_LIMIT ? 'at-cap' : ''}`}
          title={
            gemTotal >= GEM_HAND_LIMIT
              ? `Hand at ${GEM_HAND_LIMIT}-gem cap — can't take more gems this turn`
              : `${gemTotal}/${GEM_HAND_LIMIT} gems`
          }
        >
          {gemTotal}/{GEM_HAND_LIMIT}
        </span>
        {GEM_COLORS.map((c) => (
          <div
            key={`g-${c}`}
            className="readonly-cell"
            title={`${c} gems: ${player.gems[c]}`}
            aria-label={`P${idx} gem ${c}: ${player.gems[c]}`}
          >
            <span
              className="swatch gem"
              style={{ background: c === 'gold' ? GOLD_HEX : COLOR_HEX[c] }}
            />
            <span className="readonly-num">{player.gems[c]}</span>
          </div>
        ))}
        <span className="stats-sep" />
        <span
          className="readonly-prestige"
          title={`Prestige: ${player.prestige}`}
          aria-label={`P${idx} prestige: ${player.prestige}`}
        >
          ★ {player.prestige}
        </span>
      </div>

      <div className="player-row reserved-row">
        <button
          type="button"
          className="reserved-toggle"
          onClick={() => setReservedOpen((o) => !o)}
        >
          Reserved ({player.reserved.length}/3) {showReserved ? '▼' : '▶'}
        </button>
        {showReserved && (
          <div className="reserved-list">
            {player.reserved.map((r, i) => (
              <div
                key={i}
                className={`reserved-card ${highlightReservedIndex === i ? 'highlighted' : ''}`}
              >
                {r.blind === true ? (
                  <BlindCardArt tier={r.card.tier} size="small" />
                ) : (
                  <CardArt card={r.card} size="small" />
                )}
                <button
                  type="button"
                  className="reserved-remove"
                  onClick={() => onReservedRemove(i)}
                  aria-label={`Remove ${r.blind === true ? `blind T${r.card.tier}` : r.card.id} from reserved`}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
            {player.reserved.length < 3 && (
              <div className="reserved-add-tier-row">
                <span className="reserved-add-label">+ from:</span>
                {TIERS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="reserved-add-tier"
                    onClick={() => setAddingReserved(t)}
                  >
                    T{t}
                  </button>
                ))}
              </div>
            )}
            {addingReserved !== null && (
              <CardPickerModal
                tier={addingReserved}
                selected={null}
                unavailableIds={unavailableIds}
                onPick={(picked) => {
                  if (picked !== null) onReservedAdd(picked);
                  setAddingReserved(null);
                }}
                onClose={() => setAddingReserved(null)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Opponent action picker — replaces direct state editing for opponent turns.
// Every action goes through `apply()` so illegal moves are impossible.
// =============================================================================

type OpponentActionType = 'take3' | 'take2' | 'reserve' | 'buy';

function OpponentTurnPanel({
  assistantState,
  playerLabel,
  onApply,
  onSuggest,
  thinking,
  errors,
}: {
  assistantState: AssistantState;
  playerLabel: (idx: number) => string;
  onApply: (action: Action) => void;
  onSuggest: () => void;
  thinking: boolean;
  errors: string[];
}) {
  const state = useMemo(() => buildGameState(assistantState), [assistantState]);
  const opp = state.players[state.currentPlayer];
  const oppIdx = state.currentPlayer;
  const oppName = playerLabel(oppIdx);

  const [actionType, setActionType] = useState<OpponentActionType | null>(null);
  const [take3Colors, setTake3Colors] = useState<Color[]>([]);

  // Reset sub-state when the opponent changes (turn just advanced).
  useEffect(() => {
    setActionType(null);
    setTake3Colors([]);
  }, [oppIdx]);

  if (opp === undefined) return null;

  const oppGems =
    opp.gems.white + opp.gems.blue + opp.gems.green + opp.gems.red +
    opp.gems.black + opp.gems.gold;
  const headroom = GEM_HAND_LIMIT - oppGems;
  const goldAvailable = state.gemSupply.gold > 0;
  const reserveGemAdded = goldAvailable ? 1 : 0;

  // ===== Per-action-type pickers =====

  const renderTake3 = () => {
    const avail = COLORS.filter((c) => state.gemSupply[c] > 0);
    const k = Math.min(3, avail.length, headroom);
    const overcap = headroom < 1;
    const toggle = (c: Color) => {
      setTake3Colors((prev) => {
        if (prev.includes(c)) return prev.filter((x) => x !== c);
        if (prev.length >= k) return prev;
        return [...prev, c];
      });
    };
    const applyTake3 = () => {
      if (take3Colors.length === 0) return;
      onApply({ type: 'take3', colors: take3Colors });
    };
    if (overcap) {
      return (
        <p className="picker-disabled">
          {oppName} already holds {oppGems} gems — can't take any more without
          discarding. If they discarded, edit gems manually.
        </p>
      );
    }
    return (
      <>
        <p className="picker-hint">
          Click up to {k} different color{k === 1 ? '' : 's'}. Click again to
          deselect.
        </p>
        <div className="picker-color-row">
          {COLORS.map((c) => {
            const selected = take3Colors.includes(c);
            const disabled =
              state.gemSupply[c] === 0 ||
              (!selected && take3Colors.length >= k);
            return (
              <button
                key={c}
                type="button"
                className={`color-pick ${selected ? 'selected' : ''}`}
                style={{
                  background: COLOR_HEX[c],
                  color: c === 'white' ? '#1f2937' : '#fff',
                }}
                onClick={() => toggle(c)}
                disabled={disabled}
                aria-label={`take3 ${c}`}
              >
                {c.charAt(0).toUpperCase()}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="opp-apply"
          onClick={applyTake3}
          disabled={take3Colors.length === 0}
        >
          Apply ({take3Colors.length === 0
            ? 'pick at least 1 color'
            : `take ${take3Colors.join(', ')}`})
        </button>
      </>
    );
  };

  const renderTake2 = () => {
    const eligible = COLORS.filter(
      (c) => state.gemSupply[c] >= TAKE_2_MIN_PILE,
    );
    if (headroom < 2) {
      return (
        <p className="picker-disabled">
          {oppName} can't fit 2 more gems (currently has {oppGems}).
        </p>
      );
    }
    if (eligible.length === 0) {
      return (
        <p className="picker-disabled">
          No color has ≥{TAKE_2_MIN_PILE} in supply — take 2 isn't legal.
        </p>
      );
    }
    return (
      <>
        <p className="picker-hint">
          Pick a color. Only colors with ≥{TAKE_2_MIN_PILE} in supply are
          allowed.
        </p>
        <div className="picker-color-row">
          {COLORS.map((c) => {
            const disabled = state.gemSupply[c] < TAKE_2_MIN_PILE;
            return (
              <button
                key={c}
                type="button"
                className="color-pick"
                style={{
                  background: COLOR_HEX[c],
                  color: c === 'white' ? '#1f2937' : '#fff',
                }}
                onClick={() => onApply({ type: 'take2', color: c })}
                disabled={disabled}
                aria-label={`take2 ${c}`}
              >
                {c.charAt(0).toUpperCase()}
              </button>
            );
          })}
        </div>
      </>
    );
  };

  const renderReserve = () => {
    if (reserveGemAdded > headroom) {
      return (
        <p className="picker-disabled">
          {oppName} can't take the gold from reserving — they're at the
          {' '}10-gem cap. Edit their gems manually if they discarded.
        </p>
      );
    }
    return (
      <>
        <p className="picker-hint">
          Pick the face-up card they reserved, or "Blind from T-deck" if they
          drew from the top.
        </p>
        <div className="picker-reserve-area">
          {TIERS.slice().reverse().map((tier) => (
            <div key={tier} className="picker-reserve-row">
              <span className="picker-tier-label">T{tier}</span>
              <div className="picker-card-row">
                {state.faceUp[tier].map((card, i) =>
                  card !== null ? (
                    <button
                      key={i}
                      type="button"
                      className="picker-card-btn"
                      onClick={() =>
                        onApply({
                          type: 'reserve',
                          source: { kind: 'faceUp', tier, slot: i },
                        })
                      }
                      aria-label={`reserve ${card.id}`}
                    >
                      <CardArt card={card} size="small" />
                    </button>
                  ) : (
                    <div key={i} className="picker-card-empty">empty</div>
                  ),
                )}
                <button
                  type="button"
                  className="picker-blind-btn"
                  disabled={state.decks[tier].length === 0}
                  onClick={() =>
                    onApply({ type: 'reserve', source: { kind: 'deck', tier } })
                  }
                >
                  Blind from T{tier}
                </button>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  };

  const renderBuy = () => {
    type FaceUpBuy = {
      kind: 'faceUp';
      card: Card;
      tier: Tier;
      slot: number;
      payment: GemPool;
    };
    type ReserveBuy = {
      kind: 'reserve';
      card: Card;
      index: number;
      payment: GemPool;
      blind: boolean;
    };
    const buyable: Array<FaceUpBuy | ReserveBuy> = [];
    for (const tier of TIERS) {
      for (let slot = 0; slot < state.faceUp[tier].length; slot++) {
        const card = state.faceUp[tier][slot];
        if (card === null || card === undefined) continue;
        const payment = computePayment(card, opp);
        if (payment !== null) {
          buyable.push({ kind: 'faceUp', card, tier, slot, payment });
        }
      }
    }
    for (let index = 0; index < opp.reserved.length; index++) {
      const r = opp.reserved[index];
      if (r === undefined) continue;
      const payment = computePayment(r.card, opp);
      if (payment !== null) {
        buyable.push({
          kind: 'reserve',
          card: r.card,
          index,
          payment,
          blind: r.reservedFrom === 'deck',
        });
      }
    }
    if (buyable.length === 0) {
      return (
        <p className="picker-disabled">
          {oppName} can't afford any face-up or reserved card.
        </p>
      );
    }
    return (
      <>
        <p className="picker-hint">
          Pick the card {oppName} bought. Only cards they can afford are
          shown; payment is computed automatically. Reserved cards are
          tagged "from reserve".
        </p>
        <div className="picker-buy-grid">
          {buyable.map((b) => {
            const key = b.kind === 'faceUp'
              ? `f-${b.tier}-${b.slot}`
              : `r-${b.index}`;
            return (
              <button
                key={key}
                type="button"
                className="picker-card-btn"
                onClick={() =>
                  onApply(
                    b.kind === 'faceUp'
                      ? {
                          type: 'buy',
                          source: { kind: 'faceUp', tier: b.tier, slot: b.slot },
                          payment: b.payment,
                        }
                      : {
                          type: 'buy',
                          source: { kind: 'reserve', index: b.index },
                          payment: b.payment,
                        },
                  )
                }
                aria-label={
                  b.kind === 'reserve' && b.blind
                    ? `buy blind T${b.card.tier} reserve`
                    : `buy ${b.card.id}${b.kind === 'reserve' ? ' from reserve' : ''}`
                }
              >
                {b.kind === 'reserve' && b.blind ? (
                  <BlindCardArt tier={b.card.tier} size="small" />
                ) : (
                  <CardArt card={b.card} size="small" />
                )}
                {b.kind === 'reserve' && (
                  <span className="reserve-badge">
                    {b.blind ? 'blind reserve' : 'from reserve'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <div className="opponent-panel">
      <div className="opp-bar">
        <span className="opp-bar-label">{oppName}'s move:</span>
        {(['take3', 'take2', 'reserve', 'buy'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`opp-type-btn ${actionType === t ? 'active' : ''}`}
            onClick={() => {
              setActionType(t);
              setTake3Colors([]);
            }}
          >
            {t === 'take3' ? 'Take 3' : t === 'take2' ? 'Take 2' : t === 'reserve' ? 'Reserve' : 'Buy'}
          </button>
        ))}
        <span className="opp-bar-spacer" />
        <button
          type="button"
          className="opp-suggest-btn"
          onClick={onSuggest}
          disabled={thinking}
          title={`Run MCTS as if ${oppName} were choosing optimally`}
        >
          {thinking ? '…' : 'Suggest'}
        </button>
      </div>

      {errors.length > 0 && (
        <div className="issues">
          {errors.map((e, i) => (
            <div key={i}>⚠ {e}</div>
          ))}
        </div>
      )}

      {actionType !== null && (
        <div className="opp-picker-area">
          {actionType === 'take3' && renderTake3()}
          {actionType === 'take2' && renderTake2()}
          {actionType === 'reserve' && renderReserve()}
          {actionType === 'buy' && renderBuy()}
        </div>
      )}
    </div>
  );
}
