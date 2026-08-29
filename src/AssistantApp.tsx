import { useEffect, useMemo, useRef, useState } from 'react';
// useMemo is used inside CardPickerModal below.
import { apply, applyAllReveals, isTerminal, winner } from './game/apply';
import { legalActions } from './game/legalActions';
import { computePayment, meetsNobleRequirement } from './game/gems';
import { mctsBestActionWithStats, REWARD_BANDS } from './game/mcts';
import type { MctsCandidate } from './game/mcts';
import { evaluateV9 } from './game/evaluate';
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
  CardSource,
  Color,
  ColorCount,
  GameState,
  GemColor,
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
  /**
   * IDs of nobles this player has claimed. Each base-set noble is +3
   * prestige; together with `bonuses` this lets us split the player's
   * total prestige into "from cards" vs "from nobles" for the tooltip
   * breakdown without storing every purchased card.
   */
  claimedNobleIds: string[];
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
  /**
   * Append-only log of every action applied in this game, with the
   * pre-action engine state snapshot. Drives post-game analysis
   * (replay + per-move MCTS re-scoring). Reset on New game / Setup /
   * fresh sim. Not used during normal play.
   */
  gameLog: GameLogEntry[];
};

type GameLogEntry = {
  action: Action;
  /** Engine state immediately before the action was applied. */
  snapshotBefore: GameState;
  /**
   * Each player's prestige *after* the action was applied (incl. any
   * noble award triggered by the action). Cheap to compute; the chart
   * reads this directly without re-applying actions.
   */
  prestigesAfter: number[];
  /**
   * Normalized win-share estimate (sums to 1.0) per player at the moment
   * the action was applied. Null when we didn't have an MCTS estimate
   * handy (e.g. blind-reserve confirmation or noble-choice resolution
   * paths don't re-run MCTS). The chart skips null entries.
   */
  winShares: number[] | null;
};

const defaultPlayerName = (idx: number): string => `P${idx}`;

const emptyPlayer = (): PlayerForm => ({
  bonuses: emptyColorCount(),
  gems: emptyGemPool(),
  prestige: 0,
  reserved: [],
  claimedNobleIds: [],
});

const emptyFaceUp = (): FaceUpGrid => ({
  1: [null, null, null, null],
  2: [null, null, null, null],
  3: [null, null, null, null],
});

const DEFAULT_STORAGE_KEY = 'splendor-assistant-state-v1';
const HIDE_SUGGESTIONS_STORAGE_KEY = 'splendor-hide-suggestions-v1';
const LIVE_ITERATIONS_STORAGE_KEY = 'splendor-live-iterations-v1';
const LIVE_ITERATION_OPTIONS = [300, 500, 1000, 2000, 5000] as const;

const loadHideSuggestions = (): boolean => {
  try {
    return localStorage.getItem(HIDE_SUGGESTIONS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const loadLiveIterations = (): number => {
  try {
    const raw = localStorage.getItem(LIVE_ITERATIONS_STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n) && (LIVE_ITERATION_OPTIONS as readonly number[]).includes(n)) {
      return n;
    }
  } catch {
    /* ignore */
  }
  return 300;
};

const initialState = (storageKey: string): AssistantState => {
  try {
    const raw = localStorage.getItem(storageKey);
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
        claimedNobleIds: Array.isArray((p as Partial<PlayerForm>).claimedNobleIds)
          ? ((p as PlayerForm).claimedNobleIds.filter((id): id is string => typeof id === 'string'))
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
        gameLog: Array.isArray((parsed as Partial<AssistantState>).gameLog)
          ? ((parsed as AssistantState).gameLog)
          : [],
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
    gameLog: [],
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
  gameLog: prev.gameLog,
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
    claimedNobleIds: p.nobles.map((n) => n.id),
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

/**
 * Per-player purchased cards, recovered from the game log. PlayerForm only
 * stores aggregate bonus counts, but every buy entry carries the snapshot it
 * was played from, so the actual card is recoverable exactly.
 *
 * The engine needs this: `winner()` breaks prestige ties on fewest purchased
 * cards, and that tiebreak decides a real fraction of endgame rollouts. Left
 * empty, MCTS scores those ties off card counts accumulated *inside* the
 * rollout, which is not the same thing at all.
 *
 * Best-effort: cards bought before the user started logging (a game entered
 * mid-play) are not recoverable, so the count can understate.
 */
const purchasedFromLog = (s: AssistantState): Card[][] => {
  const out: Card[][] = Array.from({ length: s.numPlayers }, () => []);
  for (const entry of s.gameLog) {
    if (entry.action.type !== 'buy') continue;
    const buyerIdx = entry.snapshotBefore.currentPlayer;
    if (buyerIdx < 0 || buyerIdx >= s.numPlayers) continue;
    let card: Card | undefined;
    if (entry.action.source.kind === 'faceUp') {
      const { tier, slot } = entry.action.source;
      card = entry.snapshotBefore.faceUp[tier][slot] ?? undefined;
    } else {
      const buyer = entry.snapshotBefore.players[buyerIdx];
      card = buyer?.reserved[entry.action.source.index]?.card;
    }
    if (card !== undefined) out[buyerIdx]!.push(card);
  }
  return out;
};

/**
 * Tooltip for a candidate move's score. The number is MCTS's mean reward for
 * that branch, which is not a win probability — see REWARD_BANDS.
 */
const CANDIDATE_SCORE_HELP =
  `MCTS score for this move — not a win probability. `
  + `Above ${Math.round(REWARD_BANDS.hi * 100)}% the search reached a win in most `
  + `simulations, and the higher it goes the sooner those wins arrive. `
  + `${Math.round(REWARD_BANDS.lo * 100)}–${Math.round(REWARD_BANDS.hi * 100)}% means the `
  + `simulations ran out of depth, so it is a heuristic estimate. `
  + `Below ${Math.round(REWARD_BANDS.lo * 100)}% most simulations were lost. `
  + `Only compare it against the other moves listed here, and trust it more the `
  + `more visits the branch got.`;

const buildGameState = (s: AssistantState): GameState => {
  const decks = {
    1: tierDeckRemaining(s, 1),
    2: tierDeckRemaining(s, 2),
    3: tierDeckRemaining(s, 3),
  };
  const nobleById = new Map(ALL_NOBLES.map((n) => [n.id, n]));
  const purchased = purchasedFromLog(s);
  const players: PlayerState[] = s.players.slice(0, s.numPlayers).map((p, i) => ({
    gems: { ...p.gems },
    purchased: purchased[i] ?? [],
    // The form only carries face-up-source reserves (see ReservedFormCard
    // comment); rebuild them with the right `reservedFrom` tag here.
    reserved: p.reserved.map((r) => ({
      card: r.card,
      reservedFrom: (r.blind === true ? 'deck' : 'faceUp') as 'deck' | 'faceUp',
    })),
    nobles: p.claimedNobleIds
      .map((id) => nobleById.get(id))
      .filter((n): n is Noble => n !== undefined),
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

/**
 * Convert raw MCTS per-player rewards into a probability share that sums to
 * 1.0. The raw values are sigmoid-squashed evaluator scores in [0, 1] —
 * dividing by the sum gives the "of these likely winners, which one?" view.
 */
const normalizeWinRates = (raw: readonly number[]): number[] => {
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) return raw.map(() => 1 / raw.length);
  return raw.map((r) => r / sum);
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

export default function AssistantApp({
  storageKey = DEFAULT_STORAGE_KEY,
  mode = 'assistant',
}: {
  storageKey?: string;
  mode?: 'assistant' | 'simulator';
} = {}) {
  const [s, setS] = useState<AssistantState>(() => initialState(storageKey));
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
  // When the user clicks "buy" on a blind reserve, defer the buy until they
  // pick the real card identity. Without this the buy would commit using
  // the engine's guess card, which is what the user is trying to avoid.
  const [pendingBlindBuy, setPendingBlindBuy] = useState<{
    playerIdx: number;
    reservedIndex: number;
    tier: Tier;
  } | null>(null);
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
    /** Original action + pre-state, captured for the game log on commit. */
    action: Action;
    preState: GameState;
  } | null>(null);
  // Simulation: engine plays both sides. simRunning is the play/pause
  // state; simSpeedMs is the per-step delay (slider). Reset to defaults
  // on app load — not persisted.
  const [simRunning, setSimRunning] = useState(false);
  const [simSpeedMs, setSimSpeedMs] = useState(1200);
  // Hide MCTS-driven suggestions for honest play. When true: auto-recommend
  // is skipped, "Recompute"/opponent "Suggest" buttons are hidden, the
  // recommendation panel is suppressed, and per-player win-share pills are
  // dropped. Sim mode ignores this — it needs MCTS to drive the engine.
  const [hideSuggestions, setHideSuggestions] = useState<boolean>(
    () => mode === 'assistant' && loadHideSuggestions(),
  );
  // MCTS iterations used by every live recommendation path:
  //   - auto-recommend (debounced on state change)
  //   - Recompute (deeper) button
  //   - Opponent Suggest button
  // Higher = better picks, slower UI refresh. Persisted so the user's
  // choice survives reloads.
  const [liveIterations, setLiveIterations] = useState<number>(loadLiveIterations);
  // Game analysis (Phase G): per-turn "what if optimal?" plus a full
  // counterfactual replay from the initial position with MCTS on both
  // sides. Expensive (~10–20s per game) so it only runs on demand and
  // invalidates whenever the live game advances.
  type AnalysisPerTurn = {
    actor: number;
    bestWinShares: number[];
    actualWinShares: number[] | null;
    /** How much win-share the actor gave up by not playing the engine's pick. Clamped to [0, 1]. */
    loss: number;
    /** Engine's recommended action at this turn (for the blunder breakdown). */
    bestAction: Action;
    /** What the user actually played. */
    actualAction: Action;
    /** Narration of the recommended action (human-readable). */
    bestNarration: string;
    /** Narration of the actual action. */
    actualNarration: string;
  };
  type Counterfactual = {
    winnerIdx: number;
    winShares: number[][]; // [player][turn]
    prestiges: number[][]; // [player][turn]
    winLikelihoods: number[][]; // [player][turn], from evaluator softmax
  };
  type GameAnalysis = {
    perTurn: AnalysisPerTurn[];
    counterfactual: Counterfactual;
  };
  const [analysis, setAnalysis] = useState<GameAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<string>('');
  const [analysisIterations, setAnalysisIterations] = useState<number>(300);

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
    localStorage.setItem(storageKey, JSON.stringify(s));
  }, [storageKey, s]);

  // startingPlayer defaults to 0 on a fresh game, but the actual first
  // player is whoever was set as currentPlayer when the first action was
  // committed. If they disagree, sync — without this, isTerminal checks the
  // wrong wrap point and the game never ends.
  useEffect(() => {
    const first = s.gameLog[0];
    if (first === undefined) return;
    const actor = first.snapshotBefore.currentPlayer;
    if (actor === s.startingPlayer) return;
    setS((prev) => ({ ...prev, startingPlayer: actor as PlayerIndex }));
  }, [s.gameLog, s.startingPlayer]);

  useEffect(() => {
    if (mode !== 'assistant') return;
    try {
      localStorage.setItem(HIDE_SUGGESTIONS_STORAGE_KEY, hideSuggestions ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [hideSuggestions, mode]);

  useEffect(() => {
    try {
      localStorage.setItem(LIVE_ITERATIONS_STORAGE_KEY, String(liveIterations));
    } catch {
      /* ignore */
    }
  }, [liveIterations]);

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

  const setStartingPlayer = (idx: PlayerIndex) => {
    setS((prev) => ({ ...prev, startingPlayer: idx }));
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
      gameLog: [],
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
      gameLog: [],
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
  /**
   * Phase G: post-game analysis. Walks gameLog re-scoring every move with
   * a fresh MCTS pass, then replays from the initial state engine-vs-engine
   * to produce a counterfactual outcome ("if both sides played at engine
   * strength from the start, who wins?"). Async with setTimeout(0) yields
   * so the UI stays responsive during the ~10–20s computation.
   */
  const runAnalysis = async (iterations: number = 300) => {
    if (analyzing || s.gameLog.length < 2) return;
    setAnalyzing(true);
    setAnalysisProgress('starting…');
    setAnalysis(null);
    try {
      const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

      // --- Per-turn re-score ---
      // Canonical action serializer so we can match the user's action against
      // an MCTS candidate. Take3's color order isn't normalized by the UI so
      // we sort it for the comparison.
      const canonAction = (a: Action): string => {
        switch (a.type) {
          case 'take3':
            return `take3:${[...a.colors].sort().join(',')}`;
          case 'take2':
            return `take2:${a.color}`;
          case 'reserve':
            return a.source.kind === 'faceUp'
              ? `reserve:fu:T${a.source.tier}:s${a.source.slot}`
              : `reserve:deck:T${a.source.tier}`;
          case 'buy':
            return a.source.kind === 'faceUp'
              ? `buy:fu:T${a.source.tier}:s${a.source.slot}`
              : `buy:r:${a.source.index}`;
        }
      };
      const perTurn: AnalysisPerTurn[] = [];
      for (let i = 0; i < s.gameLog.length; i++) {
        setAnalysisProgress(`scoring move ${i + 1} / ${s.gameLog.length}`);
        await yieldFrame();
        const entry = s.gameLog[i];
        if (entry === undefined) continue;
        const stats = mctsBestActionWithStats(entry.snapshotBefore, {
          iterations,
          evalFn: evaluateV9,
          rng: seededRng((Date.now() ^ i) & 0xffff_ffff),
        });
        const bestWinShares = normalizeWinRates(stats.winRates);
        const actor = entry.snapshotBefore.currentPlayer;
        // Loss = delta between the best candidate's value and the user's
        // candidate's value, both from the actor's perspective. Falls back
        // to 0 if the user's action isn't in MCTS's candidate set (shouldn't
        // happen for legal moves, but defensive).
        const bestCand = stats.candidates[0];
        const userKey = canonAction(entry.action);
        const userCand = stats.candidates.find((c) => canonAction(c.action) === userKey);
        const loss = bestCand !== undefined && userCand !== undefined
          ? Math.max(0, bestCand.meanReward - userCand.meanReward)
          : 0;
        perTurn.push({
          actor,
          bestWinShares,
          actualWinShares: entry.winShares,
          loss,
          bestAction: stats.bestAction,
          actualAction: entry.action,
          bestNarration: narrate(entry.snapshotBefore, stats.bestAction),
          actualNarration: narrate(entry.snapshotBefore, entry.action),
        });
      }

      // --- Counterfactual replay from initial state ---
      const initialEntry = s.gameLog[0];
      if (initialEntry === undefined) {
        throw new Error('no log entries to analyse');
      }
      let cf: GameState = initialEntry.snapshotBefore;
      const cfWinShares: number[][] = Array.from(
        { length: cf.numPlayers },
        () => [] as number[],
      );
      const cfPrestiges: number[][] = Array.from(
        { length: cf.numPlayers },
        () => [] as number[],
      );
      const cfWinLikelihoods: number[][] = Array.from(
        { length: cf.numPlayers },
        () => [] as number[],
      );
      let safety = 0;
      while (!isTerminal(cf) && safety < 250) {
        setAnalysisProgress(`replaying turn ${safety + 1}…`);
        await yieldFrame();
        // Stuck player → skip just like in the live sim.
        if (legalActions(cf).length === 0) {
          cf = passTurn(cf);
          safety++;
          continue;
        }
        const stats = mctsBestActionWithStats(cf, {
          iterations,
          evalFn: evaluateV9,
          rng: seededRng((Date.now() ^ (safety + 1000)) & 0xffff_ffff),
        });
        const ws = normalizeWinRates(stats.winRates);
        cf = applyAllReveals(apply(cf, stats.bestAction));
        const wl = winLikelihoodAtState(cf, cf.numPlayers);
        for (let p = 0; p < cf.numPlayers; p++) {
          cfWinShares[p]!.push(ws[p] ?? 0);
          cfPrestiges[p]!.push(cf.players[p]?.prestige ?? 0);
          cfWinLikelihoods[p]!.push(wl[p] ?? 0);
        }
        safety++;
      }
      const cfWinner = isTerminal(cf) ? winner(cf) : 0;

      setAnalysis({
        perTurn,
        counterfactual: {
          winnerIdx: cfWinner,
          winShares: cfWinShares,
          prestiges: cfPrestiges,
          winLikelihoods: cfWinLikelihoods,
        },
      });
      setAnalysisProgress('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors([`Analysis failed: ${message}`]);
      setAnalysisProgress('');
    } finally {
      setAnalyzing(false);
    }
  };

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
      // Stuck-player check: no legal actions at all (10-gem cap + nothing
      // affordable + reserve pile full). Auto-skip the turn rather than
      // bubbling up an MCTS error.
      if (legalActions(state).length === 0) {
        const passed = passTurn(state);
        pushHistory(s);
        setS((prev) => ({ ...fromGameState(passed, prev) }));
        setRecommendation(null);
        setErrors([`${playerLabel(state.currentPlayer)} had no legal moves — turn skipped.`]);
        setThinking(false);
        return;
      }
      const start = Date.now();
      const stats = mctsBestActionWithStats(state, {
        iterations,
        evalFn: evaluateV9,
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
  ): {
    claimerIdx: number;
    autoAwarded: Noble;
    alternatives: Noble[];
    nextState: GameState;
    seenIds: string[];
  } | null => {
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

  const commitApplied = (
    next: GameState,
    seenIds: string[],
    logEntry: Omit<GameLogEntry, 'prestigesAfter' | 'winShares'> & {
      winShares: number[] | null;
    },
  ) => {
    const fullEntry: GameLogEntry = {
      ...logEntry,
      prestigesAfter: next.players.map((p) => p.prestige),
    };
    setS((prev) => ({
      ...fromGameState(next, prev),
      seenIds,
      gameLog: [...prev.gameLog, fullEntry],
    }));
    setRecommendation(null);
    setErrors([]);
    setAnalysis(null); // game advanced — stale
  };

  const onApply = (action: Action) => {
    if (unfilledFaceUpSlots.length > 0) {
      const labels = unfilledFaceUpSlots
        .map((u) => `T${u.tier} slot ${u.slot + 1}`)
        .join(', ');
      setErrors([
        `Refill the empty face-up slot${unfilledFaceUpSlots.length === 1 ? '' : 's'} (${labels}) before committing the next move.`,
      ]);
      return;
    }
    try {
      const state = buildGameState(s);
      const next = apply(state, action);
      pushHistory(s);
      const seen = collectSeen(next, s.seenIds);
      const choice = detectMultiNobleChoice(state, next, seen);
      if (choice !== null) {
        // Include the action+pre-state in the pending payload so we can
        // log it once the user resolves their choice.
        setPendingNobleChoice({ ...choice, action, preState: state });
        return; // wait for the user to resolve
      }
      commitApplied(next, seen, {
        action,
        snapshotBefore: state,
        winShares: recommendation !== null
          ? normalizeWinRates(recommendation.winRates)
          : null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors([`Apply failed: ${message}`]);
    }
  };

  /**
   * Resolves a "buy a blind reserve" flow: the user clicked Buy on a blind
   * reserve, then picked the real card identity. Reveal the reserve, recompute
   * payment against the real card's cost (the engine guess's cost can differ),
   * then commit the buy atomically against the revealed state.
   */
  const applyBlindReserveBuy = (
    playerIdx: number,
    reservedIndex: number,
    real: Card,
  ) => {
    if (unfilledFaceUpSlots.length > 0) {
      const labels = unfilledFaceUpSlots
        .map((u) => `T${u.tier} slot ${u.slot + 1}`)
        .join(', ');
      setErrors([
        `Refill the empty face-up slot${unfilledFaceUpSlots.length === 1 ? '' : 's'} (${labels}) before committing the next move.`,
      ]);
      setPendingBlindBuy(null);
      return;
    }
    try {
      const target = s.players[playerIdx];
      if (target === undefined) return;
      const existing = target.reserved[reservedIndex];
      if (existing === undefined) return;
      // Build the revealed intermediate state without committing to React yet.
      const players = s.players.slice();
      const reserved = target.reserved.slice();
      reserved[reservedIndex] = { card: real };
      players[playerIdx] = { ...target, reserved };
      const seen = new Set(s.seenIds);
      seen.delete(existing.card.id);
      seen.add(real.id);
      const intermediate: AssistantState = {
        ...s,
        players,
        seenIds: Array.from(seen),
      };
      const state = buildGameState(intermediate);
      const buyer = state.players[playerIdx];
      if (buyer === undefined) return;
      const payment = computePayment(real, buyer);
      if (payment === null) {
        // Affordability changed once the real cost is known — flush the reveal
        // so the user keeps progress, but block the buy and surface why.
        pushHistory(s);
        setS(intermediate);
        setPendingBlindBuy(null);
        setErrors([
          `Cannot afford ${real.id} (${playerLabel(playerIdx)} lacks gems for the real cost). Pick a different card to buy or undo.`,
        ]);
        return;
      }
      const action: Action = {
        type: 'buy',
        source: { kind: 'reserve', index: reservedIndex },
        payment,
      };
      const next = apply(state, action);
      pushHistory(s);
      const newSeen = collectSeen(next, intermediate.seenIds);
      const choice = detectMultiNobleChoice(state, next, newSeen);
      if (choice !== null) {
        // Reflect the reveal in s while we wait for the noble pick. preState
        // captures the revealed pre-buy state so the game log is accurate.
        setS(intermediate);
        setPendingNobleChoice({ ...choice, action, preState: state });
        setPendingBlindBuy(null);
        return;
      }
      commitApplied(next, newSeen, {
        action,
        snapshotBefore: state,
        winShares: recommendation !== null
          ? normalizeWinRates(recommendation.winRates)
          : null,
      });
      setPendingBlindBuy(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors([`Blind buy failed: ${message}`]);
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
    commitApplied(finalState, seenIds, {
      action: pendingNobleChoice.action,
      snapshotBefore: pendingNobleChoice.preState,
      winShares: recommendation !== null
        ? normalizeWinRates(recommendation.winRates)
        : null,
    });
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
    // Stuck-player edge case: every action would be illegal (10-gem cap +
    // can't afford a buy + reserve pile full). Standard Splendor doesn't
    // formally cover this; we skip the player by advancing the turn.
    if (legalActions(state).length === 0) {
      pushHistory(s);
      const passed = passTurn(state);
      setS((prev) => ({ ...fromGameState(passed, prev) }));
      setRecommendation(null);
      setErrors([]);
      return true;
    }
    try {
      const start = Date.now();
      const stats = mctsBestActionWithStats(state, {
        iterations: 300,
        evalFn: evaluateV9,
        rng: seededRng(Date.now() & 0xffff_ffff),
      });
      // apply() leaves emptied face-up slots as null + queues a reveal in
      // `pendingReveals`. In manual play the user enters the revealed card;
      // in sim mode we drive both sides ourselves, so resolve all pending
      // reveals automatically (deterministic — top of the synthetic deck).
      const next = applyAllReveals(apply(state, stats.bestAction));
      pushHistory(s);
      const seenIds = collectSeen(next, s.seenIds);
      // Inline the commit instead of using commitApplied, so we can swap
      // the cleared recommendation for one built from this step's MCTS
      // stats. Otherwise the win-chance pills go blank during sim because
      // auto-recommend is paused while simRunning.
      setS((prev) => ({
        ...fromGameState(next, prev),
        seenIds,
        gameLog: [
          ...prev.gameLog,
          {
            action: stats.bestAction,
            snapshotBefore: state,
            prestigesAfter: next.players.map((p) => p.prestige),
            winShares: normalizeWinRates(stats.winRates),
          },
        ],
      }));
      setRecommendation({
        bestAction: stats.bestAction,
        summary: describeAction(state, stats.bestAction),
        explanation: [],
        strategy: [],
        winRates: stats.winRates,
        currentPlayer: state.currentPlayer,
        rootVisits: stats.rootVisits,
        alternatives: stats.candidates.slice(1, 5).map((c) => ({
          action: c.action,
          summary: describeAction(state, c.action),
          visits: c.visits,
          meanReward: c.meanReward,
        })),
        thinkingMs: Date.now() - start,
      });
      setErrors([]);
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
        return {
          ...form,
          players,
          seenIds: Array.from(seen),
          gameLog: [
            ...prev.gameLog,
            {
              action: { type: 'reserve', source: { kind: 'deck', tier } },
              snapshotBefore: state,
              prestigesAfter: next.players.map((p) => p.prestige),
              winShares: recommendation !== null
                ? normalizeWinRates(recommendation.winRates)
                : null,
            },
          ],
        };
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
  // Per-player purchased cards. Same reconstruction the engine state uses —
  // here it drives PlayerPanel's mini card art.
  const purchasedByPlayer = useMemo(() => purchasedFromLog(s), [s]);
  // engineState now carries the real purchased lists, so the engine's own
  // tiebreak (highest prestige, then fewest cards) is the one that applies.
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

  // Ground-truth "what's been seen" derived from authoritative sources:
  //   - current face-up cards (still on the board)
  //   - current reserved cards (incl. blind-reserve engine guesses)
  //   - purchased cards reconstructed from gameLog buy actions
  // This is independent of s.seenIds, which is maintained incrementally and
  // can drift (face-up corrections, manual clears, etc.). Comparing the two
  // exposes drift; the resync button overwrites seenIds with this set.
  const derivedSeenIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tier of TIERS) {
      for (const c of s.faceUp[tier]) {
        if (c !== null) ids.add(c.id);
      }
    }
    for (const p of s.players.slice(0, s.numPlayers)) {
      for (const r of p.reserved) ids.add(r.card.id);
    }
    for (const tierCards of purchasedByPlayer) {
      for (const c of tierCards) ids.add(c.id);
    }
    return ids;
  }, [s.faceUp, s.players, s.numPlayers, purchasedByPlayer]);

  // Card IDs the engine is using as MCTS placeholders for blind reserves,
  // grouped by tier. These are NOT real "seen" cards — when a reveal picker
  // opens, every guess of the matching tier must be released from
  // unavailableIds so the user can pick any card legally still in the deck.
  const blindGuessIdsByTier = useMemo(() => {
    const out: Record<Tier, Set<string>> = {
      1: new Set(),
      2: new Set(),
      3: new Set(),
    };
    for (const p of s.players.slice(0, s.numPlayers)) {
      for (const r of p.reserved) {
        if (r.blind === true) out[r.card.tier].add(r.card.id);
      }
    }
    return out;
  }, [s.players, s.numPlayers]);

  // Face-up slots that are empty *and* fillable (deck for that tier still has
  // cards). Standard Splendor rules: you can't take a turn until the board
  // is refilled. Anything that commits a turn is gated on this being empty.
  const unfilledFaceUpSlots = useMemo(() => {
    const out: { tier: Tier; slot: number }[] = [];
    for (const tier of TIERS) {
      const deckHasCards = tierDeckRemaining(s, tier).length > 0;
      if (!deckHasCards) continue;
      for (let slot = 0; slot < s.faceUp[tier].length; slot++) {
        if (s.faceUp[tier][slot] === null) out.push({ tier, slot });
      }
    }
    return out;
  }, [s]);

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
    // User opted out of suggestions — don't burn cycles or tempt them.
    // Sim mode ignores this flag (it needs MCTS to drive the engine).
    if (hideSuggestions && mode === 'assistant') {
      setRecommendation(null);
      return;
    }
    // Sim is driving — don't fight it with the auto-recommend.
    if (simRunning) {
      return;
    }
    // Skip auto-recommend on opponent turns in Assistant mode — the user
    // doesn't need to think for their opponents, and the user can still
    // click "Suggest" in the opponent panel if they want a one-off pick.
    // Sim mode runs MCTS for everyone (it drives both sides).
    if (mode === 'assistant' && s.currentPlayer !== s.mainPlayer) {
      setRecommendation(null);
      return;
    }
    // Validation must pass before we burn cycles on a doomed run.
    const issues = validate();
    if (issues.length > 0) return;
    debounceRef.current = setTimeout(() => {
      void runMcts(liveIterations);
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
    hideSuggestions,
    mode,
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

  // ===== Auto-export on game over =====
  //
  // Dumps the full game (final state + every logged action) as JSON so the
  // user can analyse it later. Only fires once per game and only in
  // Assistant mode — sim runs would produce a flood of files. The ref
  // resets when a new game starts (gameLog cleared).
  const autoExportedRef = useRef(false);
  useEffect(() => {
    if (mode !== 'assistant') return;
    if (s.gameLog.length === 0) {
      autoExportedRef.current = false;
      return;
    }
    if (!gameOver) return;
    if (autoExportedRef.current) return;
    autoExportedRef.current = true;
    try {
      const stamp = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const ts = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
      const winnerIdx = gameWinner;
      const payload = {
        schemaVersion: 1,
        exportedAt: stamp.toISOString(),
        mode,
        numPlayers: s.numPlayers,
        startingPlayer: s.startingPlayer,
        mainPlayer: s.mainPlayer,
        playerNames: s.players
          .slice(0, s.numPlayers)
          .map((_, i) => playerLabel(i)),
        suggestionsHiddenDuringPlay: hideSuggestions,
        winner: winnerIdx === null
          ? null
          : { index: winnerIdx, label: playerLabel(winnerIdx) },
        finalState: engineState,
        gameLog: s.gameLog,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `splendor-game-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after a tick so the click navigation completes.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors((cur) => [...cur, `Game export failed: ${message}`]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally narrow deps
  }, [gameOver, s.gameLog.length, mode]);

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
  const winShares: number[] | undefined = useMemo(
    () => (recommendation === null ? undefined : normalizeWinRates(recommendation.winRates)),
    [recommendation],
  );

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
          <div className="field">
            <label title="Who took the first turn — used to detect the end-of-round wrap point">
              Started
            </label>
            <div className="pill-row">
              {Array.from({ length: s.numPlayers }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`pill ${s.startingPlayer === i ? 'active' : ''}`}
                  onClick={() => setStartingPlayer(i as PlayerIndex)}
                >
                  {playerLabel(i)}
                </button>
              ))}
            </div>
          </div>
          {mode === 'simulator' && (
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
          )}
          <div className="header-actions">
            {mode === 'assistant' && (
              <button
                type="button"
                className={`hide-suggestions-btn ${hideSuggestions ? 'active' : ''}`}
                onClick={() => setHideSuggestions((v) => !v)}
                title={
                  hideSuggestions
                    ? 'Suggestions hidden — click to re-enable the assistant'
                    : 'Hide MCTS suggestions and win-share pills so you play unaided'
                }
                aria-pressed={hideSuggestions}
              >
                {hideSuggestions ? 'Suggestions: off' : 'Suggestions: on'}
              </button>
            )}
            {(!hideSuggestions || mode === 'simulator') && (
              <label
                className="live-iter-label"
                title="MCTS iterations for live recommendations. Higher = stronger picks, slower per-turn refresh."
              >
                MCTS:
                <select
                  className="live-iter-select"
                  value={liveIterations}
                  onChange={(e) => setLiveIterations(Number(e.target.value))}
                >
                  {LIVE_ITERATION_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="undo-btn"
              onClick={onUndo}
              disabled={history.length === 0}
              title={history.length === 0 ? 'Nothing to undo' : 'Restore the previous state'}
            >
              ↶
            </button>
            {mode === 'simulator' && (
              <button
                type="button"
                className="setup-btn"
                onClick={setupFreshDeal}
                title="Deal 4 face-up cards per tier and numPlayers+1 nobles at random — no auto-play"
              >
                🎲 Setup
              </button>
            )}
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
        {unfilledFaceUpSlots.length > 0 && !gameOver && (
          <div className="unfilled-slots-banner">
            ⚠ Refill {unfilledFaceUpSlots.length === 1 ? 'this slot' : `${unfilledFaceUpSlots.length} slots`} before the next move:{' '}
            {unfilledFaceUpSlots
              .map((u) => `T${u.tier} slot ${u.slot + 1}`)
              .join(', ')}
            . Click an empty slot below to pick its card.
          </div>
        )}
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
                      // Maintain seenIds correctly across every transition:
                      //   null → card   : add the new card.
                      //   card → null   : remove the old card (correction).
                      //   cardA → cardB : add B, remove A (correction with
                      //                   replacement — without the remove,
                      //                   A leaks into seenIds forever and
                      //                   silently hides itself from pickers).
                      const seen = new Set(prev.seenIds);
                      if (prevCard !== null && prevCard !== undefined && prevCard.id !== picked?.id) {
                        seen.delete(prevCard.id);
                      }
                      if (picked !== null) seen.add(picked.id);
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
              {(() => {
                const tierTotal = ALL_CARDS.filter((c) => c.tier === tier).length;
                const derivedSeenForTier = Array.from(derivedSeenIds).filter(
                  (id) => id.startsWith(`T${tier}-`),
                ).length;
                const derivedDeck = tierTotal - derivedSeenForTier;
                const drift = derivedDeck - tierDeckRemaining(s, tier).length;
                if (drift === 0) return null;
                return (
                  <span
                    className="deck-audit"
                    title={
                      `Audit (purchased+reserved+face-up) suggests ${derivedDeck} card${derivedDeck === 1 ? '' : 's'} remain in the T${tier} deck — `
                      + `${drift > 0 ? `assistant has ${drift} extra seen-ID${drift === 1 ? '' : 's'} (drift/leak)` : `assistant is missing ${-drift} seen-ID${drift === -1 ? '' : 's'} (e.g., from a Mark-deck-empty)`}. `
                      + `Click resync to replace seenIds with the audit set.`
                    }
                  >
                    ⚠ audit: {derivedDeck}
                    <button
                      type="button"
                      className="resync-deck"
                      onClick={() => {
                        const before = tierDeckRemaining(s, tier).length;
                        const msg = `Resync T${tier} seenIds to the audit?\n\n`
                          + `Before: ${before} card${before === 1 ? '' : 's'} in deck.\n`
                          + `After:  ${derivedDeck} card${derivedDeck === 1 ? '' : 's'} in deck.\n\n`
                          + `This overwrites the assistant's seen-IDs for T${tier} with cards actually accounted for in purchased + reserved + face-up.`;
                        if (!window.confirm(msg)) return;
                        setS((prev) => {
                          // Replace just this tier's seen-IDs with the derived set.
                          const otherTiers = prev.seenIds.filter(
                            (id) => !id.startsWith(`T${tier}-`),
                          );
                          const thisTier = Array.from(derivedSeenIds).filter(
                            (id) => id.startsWith(`T${tier}-`),
                          );
                          return { ...prev, seenIds: [...otherTiers, ...thisTier] };
                        });
                      }}
                    >
                      resync
                    </button>
                  </span>
                );
              })()}
              {tierDeckRemaining(s, tier).length > 0
                && s.faceUp[tier].some((c) => c === null) && (
                <button
                  type="button"
                  className="mark-deck-empty"
                  onClick={() => {
                    if (!window.confirm(
                      `Mark the T${tier} deck as empty?\n\n`
                      + `This adds all ${tierDeckRemaining(s, tier).length} remaining T${tier} card(s) to "seen" so empty slots stay empty. `
                      + `Use only if the physical deck is genuinely exhausted.`,
                    )) return;
                    setS((prev) => {
                      const remaining = tierDeckRemaining(prev, tier);
                      const seen = new Set(prev.seenIds);
                      for (const c of remaining) seen.add(c.id);
                      return { ...prev, seenIds: Array.from(seen) };
                    });
                  }}
                  title={`Override: mark T${tier} deck as physically empty (recovers from tracking drift)`}
                >
                  deck empty?
                </button>
              )}
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
        {pendingBlindBuy !== null && (() => {
          // Release every blind-reserve guess of this tier — those are MCTS
          // placeholders, not real "seen" cards. The user should be able to
          // pick any card legally still in the deck, regardless of which
          // imaginary cards other blind reserves are pretending to be.
          const pickerUnavailable = new Set(usedCardIds);
          for (const id of blindGuessIdsByTier[pendingBlindBuy.tier]) {
            pickerUnavailable.delete(id);
          }
          return (
            <CardPickerModal
              tier={pendingBlindBuy.tier}
              selected={null}
              unavailableIds={pickerUnavailable}
              title={`Which T${pendingBlindBuy.tier} card is ${playerLabel(pendingBlindBuy.playerIdx)} buying from their blind reserve?`}
              onPick={(picked) => {
                if (picked !== null) {
                  applyBlindReserveBuy(
                    pendingBlindBuy.playerIdx,
                    pendingBlindBuy.reservedIndex,
                    picked,
                  );
                } else {
                  setPendingBlindBuy(null);
                }
              }}
              onClose={() => setPendingBlindBuy(null)}
            />
          );
        })()}
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
            blindGuessIdsByTier={blindGuessIdsByTier}
            purchased={purchasedByPlayer[idx] ?? []}
            winRate={hideSuggestions ? undefined : winShares?.[idx]}
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
            onReservedReveal={(i, picked) =>
              setS((prev) => {
                const players = prev.players.slice();
                const target = players[idx];
                if (target === undefined) return prev;
                const reserved = target.reserved.slice();
                const existing = reserved[i];
                if (existing === undefined) return prev;
                // Swap engine guess → real card, drop blind flag.
                reserved[i] = { card: picked };
                players[idx] = { ...target, reserved };
                // Release the guess back into its tier deck, claim the real one.
                const seen = new Set(prev.seenIds);
                seen.delete(existing.card.id);
                seen.add(picked.id);
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
              {s.players[gameWinner]?.prestige ?? 0} prestige
              {' '}({purchasedByPlayer[gameWinner]?.length ?? 0} cards).
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
        {!gameOver && (s.currentPlayer !== s.mainPlayer || hideSuggestions) && (
          <OpponentTurnPanel
            assistantState={s}
            playerLabel={playerLabel}
            onApply={onApply}
            onSuggest={() => void runMcts(Math.max(liveIterations, 500))}
            thinking={thinking}
            errors={errors}
            hideSuggestions={hideSuggestions}
            onBuyBlindReserve={(playerIdx, reservedIndex, tier) =>
              setPendingBlindBuy({ playerIdx, reservedIndex, tier })
            }
          />
        )}
        {!gameOver && s.currentPlayer === s.mainPlayer && !hideSuggestions && (
          <>
            <div className="recommend-header">
              <strong>Your turn ({playerLabel(s.mainPlayer)})</strong>
              <div className="recommend-status">
                {thinking && <span className="thinking-indicator">Thinking…</span>}
                <button
                  type="button"
                  className="recompute-btn"
                  onClick={() => void runMcts(Math.max(liveIterations, 500))}
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
        {!hideSuggestions && recommendation && (
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
                        <span className="alt-meta" title={CANDIDATE_SCORE_HELP}>
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

      {/* Analytics panel: live during sim, post-game in Assistant tab. */}
      {(mode === 'simulator' || gameOver) && s.gameLog.length > 1 && (
        <section className="card analytics-card">
          <h2>
            {gameOver ? 'Game review' : 'Game so far'}
            <span className="analytics-sub">
              · turn {s.gameLog.length}
              {gameOver && gameWinner !== null && (
                <> · winner: <strong>{playerLabel(gameWinner)}</strong></>
              )}
            </span>
          </h2>
          <StackedAreaChart
            title="Win likelihood over time"
            playerLabels={s.players
              .slice(0, s.numPlayers)
              .map((_, i) => playerLabel(i))}
            series={buildWinLikelihoodSeries(s.gameLog, s.numPlayers)}
          />
          <p className="chart-help">
            Each turn's column sums to 100%. Band thickness = engine's
            confidence that player will win, derived by softmax over a
            heuristic state evaluation. Roughly 1/N each while positions
            are comparable; the leader's band widens as they pull ahead;
            the final ply snaps to the actual winner.
          </p>
          <HistoryChart
            yLabel="Prestige over time"
            yMax={Math.max(
              15,
              ...s.gameLog.flatMap((e) => e.prestigesAfter),
            )}
            playerLabels={s.players
              .slice(0, s.numPlayers)
              .map((_, i) => playerLabel(i))}
            series={s.players
              .slice(0, s.numPlayers)
              .map((_, pIdx) =>
                s.gameLog.map((e) => e.prestigesAfter[pIdx] ?? 0),
              )}
            format={(v) => v.toFixed(0)}
          />

          {/* Deep analysis: per-move blunder check + counterfactual replay */}
          <div className="analysis-controls">
            <button
              type="button"
              className="analysis-btn"
              onClick={() => void runAnalysis(analysisIterations)}
              disabled={analyzing}
              title="Re-runs MCTS for every move and replays the game engine-vs-engine."
            >
              {analyzing
                ? `Analysing — ${analysisProgress}`
                : `Run deep analysis (${analysisIterations} iter)`}
            </button>
            <label className="analysis-iter-label">
              Iterations:
              <select
                className="analysis-iter-select"
                value={analysisIterations}
                onChange={(e) => setAnalysisIterations(Number(e.target.value))}
                disabled={analyzing}
                title="Higher = more accurate MCTS evaluation, longer runtime"
              >
                <option value={300}>300 (fast)</option>
                <option value={500}>500</option>
                <option value={1000}>1000 (recommended)</option>
                <option value={2000}>2000 (slow)</option>
                <option value={5000}>5000 (very slow)</option>
              </select>
            </label>
            {analysisIterations >= 1000 && (
              <span className="analysis-iter-note">
                ≈{Math.round((s.gameLog.length * 2 * analysisIterations) / 300 / 10) / 100}× longer than the 300-iter run
              </span>
            )}
            {analysis !== null && (
              <span className="analysis-cf-banner">
                Engine-vs-engine replay winner:{' '}
                <strong>{playerLabel(analysis.counterfactual.winnerIdx)}</strong>
              </span>
            )}
          </div>

          {analysis !== null && (
            <>
              {/* Per-player blunder summary */}
              <div className="blunder-grid">
                {s.players.slice(0, s.numPlayers).map((_, pIdx) => {
                  // Index moves with their global turn number BEFORE filtering,
                  // so the "turn N" label matches the real game log.
                  const movesWithIdx = analysis.perTurn
                    .map((m, idx) => ({ ...m, turn: idx + 1 }))
                    .filter((m) => m.actor === pIdx);
                  const totalLoss = movesWithIdx.reduce((a, m) => a + m.loss, 0);
                  const blunders = movesWithIdx
                    .filter((m) => m.loss >= 0.05)
                    .sort((a, b) => b.loss - a.loss)
                    .slice(0, 5);
                  return (
                    <div key={pIdx} className="blunder-card">
                      <div className="blunder-name">{playerLabel(pIdx)}</div>
                      <div className="blunder-stat">
                        <span className="blunder-label">Win-share lost to sub-optimal moves</span>
                        <span className="blunder-val">
                          {(totalLoss * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="blunder-stat">
                        <span className="blunder-label">Moves with ≥5% loss</span>
                        <span className="blunder-val">{blunders.length}</span>
                      </div>
                      {blunders.length > 0 ? (
                        <details className="blunder-details">
                          <summary>Top {blunders.length} blunder{blunders.length === 1 ? '' : 's'}</summary>
                          <ol className="blunder-list">
                            {blunders.map((b, k) => (
                              <li key={k}>
                                <div className="blunder-turn">
                                  Turn {b.turn} · –{(b.loss * 100).toFixed(1)}%
                                </div>
                                <div className="blunder-played">
                                  Played: {namifyNarration(b.actualNarration)}
                                </div>
                                <div className="blunder-best">
                                  Engine: {namifyNarration(b.bestNarration)}
                                </div>
                              </li>
                            ))}
                          </ol>
                        </details>
                      ) : (
                        <div className="blunder-worst clean">
                          No moves with ≥5% loss — clean play.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Counterfactual chart: engine-vs-engine from the start */}
              <div className="chart-cf-title">
                Counterfactual (engine vs engine from turn 1)
              </div>
              <StackedAreaChart
                title="Counterfactual win likelihood"
                playerLabels={s.players
                  .slice(0, s.numPlayers)
                  .map((_, i) => playerLabel(i))}
                series={analysis.counterfactual.winLikelihoods}
              />
              <HistoryChart
                yLabel="Counterfactual prestige (engine vs engine from turn 1)"
                yMax={Math.max(
                  15,
                  ...analysis.counterfactual.prestiges.flat(),
                )}
                playerLabels={s.players
                  .slice(0, s.numPlayers)
                  .map((_, i) => playerLabel(i))}
                series={analysis.counterfactual.prestiges}
                format={(v) => v.toFixed(0)}
              />
            </>
          )}
        </section>
      )}
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

// =============================================================================
// History chart — small inline SVG, one line per player. Used for both the
// win-share trajectory and the prestige trajectory.
// =============================================================================

const CHART_PALETTE = ['#1f2937', '#dc2626', '#2563eb', '#15803d'];

/**
 * Compute a "win likelihood" share per player at a given state.
 *
 * Why not MCTS? MCTS at 300 iter is a conservative estimator — when four
 * players have comparable positions the rollouts squash to ~1.0 each and
 * the normalized share is uninformatively close to 1/N. The chart was
 * flat through the entire game until the very last ply.
 *
 * Why the evaluator + softmax? `evaluateV9` is a deterministic, smooth
 * function of the state (prestige + bonuses + noble proximity + opponent
 * threat). Softmax across players amplifies the leader's score relative
 * to the rest — mid-game (similar scores) stays near 1/N, late-game
 * (one player clearly ahead) converges to that player, terminal states
 * collapse to ~100% for the winner. Same poker-equity arc the user
 * asked about, without rollout noise.
 *
 * Temperature ≈ 5 picked to match the engine's existing `squash` scale
 * (`sigmoid(x/5)`) so the math sits in the same regime as MCTS.
 */
// Temperature picked empirically: at T=3 a 5-point evaluator gap yields
// ~83% for the leader, a 10-point gap ~95% — enough to show real late-game
// divergence without making 2-point fluctuations look decisive. Lower
// would over-react to noise; higher (e.g. 5) leaves the bands too flat.
const SOFTMAX_TEMPERATURE = 3;

const winLikelihoodAtState = (state: GameState, numPlayers: number): number[] => {
  // Terminal-state shortcut: once the round is locked in, the winner is the
  // winner. Forces the chart's final pixel to a clean 100% / 0% rather than
  // leaving it as the softmax estimate (which is sharp but not exactly 100).
  if (isTerminal(state)) {
    const w = winner(state);
    return Array.from({ length: numPlayers }, (_, i) => (i === w ? 1 : 0));
  }
  const scores = Array.from({ length: numPlayers }, (_, i) =>
    evaluateV9(state, i as PlayerIndex),
  );
  const exps = scores.map((s) => Math.exp(s / SOFTMAX_TEMPERATURE));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (sum <= 0) return scores.map(() => 1 / numPlayers);
  return exps.map((e) => e / sum);
};

/**
 * Pass-the-turn helper for the (rare) state where a player has no legal
 * actions. Standard Splendor rules don't formally cover this, but the
 * pragmatic interpretation is "skip the player". Just advance the
 * currentPlayer/turnNumber pair — apply() does the same at the end of
 * every action, this is the same maneuver minus any action effects.
 */
const passTurn = (state: GameState): GameState => ({
  ...state,
  currentPlayer: ((state.currentPlayer + 1) % state.numPlayers) as PlayerIndex,
  turnNumber: state.turnNumber + 1,
});

const buildWinLikelihoodSeries = (
  gameLog: GameLogEntry[],
  numPlayers: number,
): number[][] => {
  // Plot the *post-action* state at each turn so the final entry reflects
  // the actual position the game ends in (otherwise the chart is always
  // one ply behind the win condition).
  const series: number[][] = Array.from({ length: numPlayers }, () => []);
  for (const entry of gameLog) {
    let post: GameState;
    try {
      post = apply(entry.snapshotBefore, entry.action);
    } catch {
      post = entry.snapshotBefore;
    }
    const w = winLikelihoodAtState(post, numPlayers);
    for (let p = 0; p < numPlayers; p++) series[p]!.push(w[p] ?? 0);
  }
  return series;
};

/**
 * Stacked-area chart used for win-share (which always sums to 1.0 per
 * turn). A line chart of 4 players hovering near 25% looks dead flat;
 * the stacked area visualises *relative* dominance — whoever has more
 * vertical band at a given turn is the leader.
 */
function StackedAreaChart({
  title,
  series,
  playerLabels,
  height = 110,
  format = (v) => `${(v * 100).toFixed(0)}%`,
  emptyMessage = 'need at least 2 turns to plot',
}: {
  title: string;
  series: number[][]; // [player][turn], each column sums to ~1
  playerLabels: string[];
  height?: number;
  format?: (v: number) => string;
  emptyMessage?: string;
}) {
  const numPlayers = series.length;
  const numTurns = series[0]?.length ?? 0;
  if (numTurns < 2) {
    return <div className="chart-empty">{title}: {emptyMessage}</div>;
  }
  const padding = { top: 8, right: 8, bottom: 16, left: 28 };
  const widthInner = Math.max(160, numTurns * 14);
  const heightInner = height - padding.top - padding.bottom;
  const total = padding.left + widthInner + padding.right;
  const xAt = (i: number) =>
    padding.left + (numTurns === 1 ? widthInner / 2 : (i / (numTurns - 1)) * widthInner);
  const yAt = (v: number) =>
    padding.top + heightInner * (1 - Math.max(0, Math.min(1, v)));
  // Cumulative stacks per turn so that band p sits between cumulative[p-1]
  // and cumulative[p] (clamped to 1 in case sums drift slightly).
  const cumulative: number[][] = [];
  for (let p = 0; p < numPlayers; p++) {
    cumulative.push([]);
    for (let t = 0; t < numTurns; t++) {
      const prev = p > 0 ? cumulative[p - 1]![t] ?? 0 : 0;
      const v = series[p]?.[t] ?? 0;
      cumulative[p]!.push(Math.min(1, prev + v));
    }
  }
  const lastValues = series.map((s) => s[s.length - 1] ?? 0);
  return (
    <div className="chart">
      <div className="chart-header">
        <div className="chart-title">{title}</div>
        <div className="chart-legend">
          {playerLabels.map((name, i) => (
            <span key={i} className="chart-legend-item">
              <span
                className="chart-legend-dot"
                style={{ background: CHART_PALETTE[i % CHART_PALETTE.length] }}
              />
              {name} <span className="chart-legend-val">{format(lastValues[i] ?? 0)}</span>
            </span>
          ))}
        </div>
      </div>
      <svg width={total} height={height} className="chart-svg">
        <line
          x1={padding.left} y1={padding.top}
          x2={padding.left} y2={height - padding.bottom}
          stroke="#e5e7eb"
        />
        <line
          x1={padding.left} y1={height - padding.bottom}
          x2={total - padding.right} y2={height - padding.bottom}
          stroke="#e5e7eb"
        />
        <text x={padding.left - 4} y={padding.top + 4} textAnchor="end" className="chart-tick">
          100%
        </text>
        <text
          x={padding.left - 4} y={height - padding.bottom}
          textAnchor="end" className="chart-tick"
        >
          0
        </text>
        {Array.from({ length: numPlayers }, (_, p) => {
          // Build a closed band: top edge (cumulative[p]) left→right, then
          // bottom edge (cumulative[p-1] or 0) right→left.
          const top = cumulative[p]!;
          const below = p > 0 ? cumulative[p - 1]! : new Array(numTurns).fill(0);
          const topPath = top
            .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`)
            .join(' ');
          const bottomPath = below
            .map((_, i) => {
              const idx = numTurns - 1 - i;
              return `L ${xAt(idx)} ${yAt(below[idx] ?? 0)}`;
            })
            .join(' ');
          return (
            <path
              key={p}
              d={`${topPath} ${bottomPath} Z`}
              fill={CHART_PALETTE[p % CHART_PALETTE.length]}
              fillOpacity={0.82}
              stroke={CHART_PALETTE[p % CHART_PALETTE.length]}
              strokeWidth={0.5}
            />
          );
        })}
      </svg>
    </div>
  );
}

function HistoryChart({
  series,
  yMax,
  yLabel,
  height = 110,
  playerLabels,
  format = (v) => v.toFixed(2),
}: {
  series: number[][]; // [player][turn] = value
  yMax: number;       // top of y-axis (0..yMax)
  yLabel: string;
  height?: number;
  playerLabels: string[];
  format?: (v: number) => string;
}) {
  const numTurns = series[0]?.length ?? 0;
  if (numTurns < 2) {
    return (
      <div className="chart-empty">{yLabel}: need at least 2 turns to plot</div>
    );
  }
  const padding = { top: 8, right: 8, bottom: 16, left: 28 };
  const widthInner = Math.max(160, numTurns * 14);
  const heightInner = height - padding.top - padding.bottom;
  const xAt = (i: number) =>
    padding.left + (numTurns === 1 ? widthInner / 2 : (i / (numTurns - 1)) * widthInner);
  const yAt = (v: number) =>
    padding.top + heightInner * (1 - Math.max(0, Math.min(yMax, v)) / yMax);
  const total = padding.left + widthInner + padding.right;
  const lastValues = series.map((s) => s[s.length - 1] ?? 0);
  return (
    <div className="chart">
      <div className="chart-header">
        <div className="chart-title">{yLabel}</div>
        <div className="chart-legend">
          {playerLabels.map((name, i) => (
            <span key={i} className="chart-legend-item">
              <span
                className="chart-legend-dot"
                style={{ background: CHART_PALETTE[i % CHART_PALETTE.length] }}
              />
              {name} <span className="chart-legend-val">{format(lastValues[i] ?? 0)}</span>
            </span>
          ))}
        </div>
      </div>
      <svg width={total} height={height} className="chart-svg">
        {/* y-axis baseline + top guide */}
        <line
          x1={padding.left} y1={padding.top}
          x2={padding.left} y2={height - padding.bottom}
          stroke="#e5e7eb"
        />
        <line
          x1={padding.left} y1={height - padding.bottom}
          x2={total - padding.right} y2={height - padding.bottom}
          stroke="#e5e7eb"
        />
        <text x={padding.left - 4} y={padding.top + 4} textAnchor="end" className="chart-tick">
          {format(yMax)}
        </text>
        <text
          x={padding.left - 4} y={height - padding.bottom}
          textAnchor="end" className="chart-tick"
        >
          0
        </text>
        {series.map((line, pIdx) => {
          const d = line
            .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`)
            .join(' ');
          return (
            <path
              key={pIdx}
              d={d}
              fill="none"
              stroke={CHART_PALETTE[pIdx % CHART_PALETTE.length]}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </svg>
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
  // Escape hatch: if our seenIds tracking has drifted and the card the user
  // needs is missing, they can flip this to see every tier-T card.
  const [showAll, setShowAll] = useState(false);

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
      .filter((c) => showAll || !unavailableIds.has(c.id) || c.id === selected?.id)
      .sort((a, b) => {
        const r = colorRank[a.bonus] - colorRank[b.bonus];
        if (r !== 0) return r;
        const p = a.prestige - b.prestige;
        if (p !== 0) return p;
        return totalCost(a) - totalCost(b);
      });
  }, [tier, unavailableIds, selected, showAll]);
  const filteredOutCount = ALL_CARDS.filter((c) => c.tier === tier).length - cards.length;

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
            {(showAll || filteredOutCount > 0) && (
              <button
                type="button"
                className={`picker-show-all ${showAll ? 'active' : ''}`}
                onClick={() => setShowAll((v) => !v)}
                title={
                  showAll
                    ? 'Hide cards the assistant thinks are already in play'
                    : `Reveal ${filteredOutCount} hidden card${filteredOutCount === 1 ? '' : 's'} (use if the assistant has filtered out the one you need)`
                }
              >
                {showAll ? 'Hide tracked' : `Show all (${filteredOutCount} hidden)`}
              </button>
            )}
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
              const isTracked = showAll && unavailableIds.has(c.id) && c.id !== selected?.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`picker-tile ${isSelected ? 'selected' : ''} ${isTracked ? 'tracked-elsewhere' : ''}`}
                  onClick={() => onPick(c)}
                  title={isTracked ? `${c.id} (assistant has this marked as already in play)` : c.id}
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
  blindGuessIdsByTier,
  purchased,
  winRate,
  qualifyingNobles,
  highlightReservedIndex,
  onName,
  onReservedAdd,
  onReservedRemove,
  onReservedReveal,
}: {
  idx: number;
  name: string;
  isCurrent: boolean;
  player: PlayerForm;
  unavailableIds: Set<string>;
  blindGuessIdsByTier: Record<Tier, Set<string>>;
  purchased: Card[];
  winRate: number | undefined;
  qualifyingNobles: Noble[];
  highlightReservedIndex: number | undefined;
  onName: (name: string) => void;
  onReservedAdd: (card: Card) => void;
  onReservedRemove: (i: number) => void;
  onReservedReveal: (i: number, card: Card) => void;
}) {
  const [purchasedOpen, setPurchasedOpen] = useState(false);
  const [reservedOpen, setReservedOpen] = useState(false);
  // When the engine highlights one of our reserved cards (buy-from-reserve
  // recommendation), force the drawer open so the user can see which one
  // is being suggested without an extra click.
  const showReserved = reservedOpen || highlightReservedIndex !== undefined;
  // Running total of gems incl. gold. Hits GEM_HAND_LIMIT (10) → can't take
  // any more gems this turn; surface as a warning in the header.
  const gemTotal = GEM_COLORS.reduce((s, c) => s + player.gems[c], 0);
  const [addingReserved, setAddingReserved] = useState<Tier | null>(null);
  // When set, opens the card picker so the user can replace the engine's
  // guess on a blind reserve with the real card.
  const [revealingReserved, setRevealingReserved] = useState<
    { i: number; tier: Tier } | null
  >(null);
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
          title={
            // Breakdown: each claimed noble is +3 prestige; the rest comes
            // from purchased cards. Helps the user see "I'm winning thanks
            // to my nobles" vs "thanks to high-tier card prestige".
            player.claimedNobleIds.length > 0
              ? `${player.prestige} prestige = ${
                  player.prestige - player.claimedNobleIds.length * 3
                } from cards + ${player.claimedNobleIds.length * 3} from ${
                  player.claimedNobleIds.length
                } noble${player.claimedNobleIds.length === 1 ? '' : 's'}`
              : `${player.prestige} prestige (all from cards — no nobles yet)`
          }
          aria-label={`P${idx} prestige: ${player.prestige}`}
        >
          ★ {player.prestige}
          {player.claimedNobleIds.length > 0 && (
            <span className="prestige-noble-split">
              {' '}({player.prestige - player.claimedNobleIds.length * 3}+{player.claimedNobleIds.length * 3})
            </span>
          )}
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
                  <button
                    type="button"
                    className="reserved-reveal-btn"
                    onClick={() => setRevealingReserved({ i, tier: r.card.tier })}
                    title="Reveal — pick the actual card that was reserved"
                    aria-label={`Reveal blind T${r.card.tier} reserve`}
                  >
                    <BlindCardArt tier={r.card.tier} size="small" />
                    <span className="reveal-hint">reveal</span>
                  </button>
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
            {revealingReserved !== null && (
              <CardPickerModal
                tier={revealingReserved.tier}
                selected={null}
                unavailableIds={
                  // Release every blind-reserve guess of this tier (across
                  // all players) — they're MCTS placeholders, not real cards
                  // out of the deck. The user should see every card still
                  // legally available, regardless of what other reserves
                  // pretend to be.
                  (() => {
                    const next = new Set(unavailableIds);
                    for (const id of blindGuessIdsByTier[revealingReserved.tier]) {
                      next.delete(id);
                    }
                    return next;
                  })()
                }
                onPick={(picked) => {
                  if (picked !== null) onReservedReveal(revealingReserved.i, picked);
                  setRevealingReserved(null);
                }}
                onClose={() => setRevealingReserved(null)}
              />
            )}
          </div>
        )}
      </div>

      {purchased.length > 0 && (
        <div className="player-row purchased-row">
          <button
            type="button"
            className="reserved-toggle"
            onClick={() => setPurchasedOpen((o) => !o)}
            title="Cards this player has bought so far (reconstructed from the game log)"
          >
            Purchased ({purchased.length}) {purchasedOpen ? '▼' : '▶'}
          </button>
          {purchasedOpen && (
            <div className="purchased-list">
              {TIERS.slice().reverse().map((tier) => {
                const cardsForTier = purchased.filter((c) => c.tier === tier);
                if (cardsForTier.length === 0) return null;
                return (
                  <div key={tier} className="purchased-tier-row">
                    <span className="purchased-tier-label">T{tier}</span>
                    <div className="purchased-cards">
                      {cardsForTier.map((c, i) => (
                        <CardArt key={`${c.id}-${i}`} card={c} size="small" />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
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
  hideSuggestions,
  onBuyBlindReserve,
}: {
  assistantState: AssistantState;
  playerLabel: (idx: number) => string;
  onApply: (action: Action) => void;
  onSuggest: () => void;
  thinking: boolean;
  errors: string[];
  hideSuggestions: boolean;
  onBuyBlindReserve: (
    playerIdx: number,
    reservedIndex: number,
    tier: Tier,
  ) => void;
}) {
  const state = useMemo(() => buildGameState(assistantState), [assistantState]);
  const opp = state.players[state.currentPlayer];
  const oppIdx = state.currentPlayer;
  const oppName = playerLabel(oppIdx);

  const [actionType, setActionType] = useState<OpponentActionType | null>(null);
  const [take3Colors, setTake3Colors] = useState<Color[]>([]);
  // Take-2 and reserve normally commit on click. They only turn into a
  // two-step flow when the action breaches the gem cap and we first need to
  // know which gems go back.
  const [take2Color, setTake2Color] = useState<Color | null>(null);
  const [pendingReserve, setPendingReserve] = useState<CardSource | null>(null);
  // Gems handed back to the supply this turn (10-gem cap rule).
  const [discard, setDiscard] = useState<GemPool>(emptyGemPool());

  const resetPicker = () => {
    setTake3Colors([]);
    setTake2Color(null);
    setPendingReserve(null);
    setDiscard(emptyGemPool());
  };

  // Reset sub-state when the opponent changes (turn just advanced).
  useEffect(() => {
    setActionType(null);
    setTake3Colors([]);
    setTake2Color(null);
    setPendingReserve(null);
    setDiscard(emptyGemPool());
  }, [oppIdx]);

  if (opp === undefined) return null;

  const oppGems =
    opp.gems.white + opp.gems.blue + opp.gems.green + opp.gems.red +
    opp.gems.black + opp.gems.gold;
  const goldAvailable = state.gemSupply.gold > 0;

  // ===== 10-gem cap =====
  // The cap is a *return* rule, not a take restriction: a player sitting on 10
  // gems may still take (that's how a one-gem swap works), they just put the
  // excess back. The returned gems ride along on the action so apply() moves
  // them to the supply in the same atomic step.

  const poolTotal = (p: GemPool): number =>
    GEM_COLORS.reduce((n, c) => n + p[c], 0);
  const discardTotal = poolTotal(discard);
  const takeTwoPool = (c: Color): GemPool => {
    const pool = emptyGemPool();
    pool[c] = 2;
    return pool;
  };
  const reservePool = (): GemPool => {
    const pool = emptyGemPool();
    if (goldAvailable) pool.gold = 1;
    return pool;
  };
  const discardNeeded = (taken: GemPool): number =>
    Math.max(0, oppGems + poolTotal(taken) - GEM_HAND_LIMIT);
  const discardReady = (taken: GemPool): boolean =>
    discardTotal === discardNeeded(taken);
  const discardArg = (taken: GemPool): GemPool | undefined =>
    discardNeeded(taken) > 0 ? discard : undefined;
  const describeDiscard = (): string =>
    GEM_COLORS.filter((c) => discard[c] > 0)
      .map((c) => `${discard[c]} ${c}`)
      .join(' + ');

  /** Gem-return picker. Renders nothing unless the take breaches the cap. */
  const renderDiscard = (taken: GemPool) => {
    const need = discardNeeded(taken);
    if (need === 0) return null;
    const bump = (c: GemColor) => {
      const held = opp.gems[c] + taken[c];
      setDiscard((prev) => {
        const canAdd = prev[c] < held && poolTotal(prev) < need;
        // A colour that can't go higher resets to 0, so a misclick costs one
        // more click instead of needing a separate clear button.
        return { ...prev, [c]: canAdd ? prev[c] + 1 : 0 };
      });
    };
    return (
      <div className="picker-discard">
        <p className="picker-hint">
          That would put {oppName} at {oppGems + poolTotal(taken)} gems — pick{' '}
          {need} to return ({discardTotal}/{need} chosen). Click a gem to add
          one; click past its max to clear that colour.
        </p>
        <div className="picker-color-row">
          {GEM_COLORS.map((c) => {
            const held = opp.gems[c] + taken[c];
            return (
              <button
                key={c}
                type="button"
                className={`color-pick discard-pick ${discard[c] > 0 ? 'selected' : ''}`}
                style={{
                  background: c === 'gold' ? GOLD_HEX : COLOR_HEX[c],
                  color: c === 'white' || c === 'gold' ? '#1f2937' : '#fff',
                }}
                onClick={() => bump(c)}
                disabled={held === 0}
                title={`${oppName} holds ${held} ${c} after taking`}
                aria-label={`return ${c}`}
              >
                {c === 'gold' ? '★' : c.charAt(0).toUpperCase()}
                {discard[c] > 0 ? `−${discard[c]}` : ''}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  // ===== Per-action-type pickers =====

  const renderTake3 = () => {
    const avail = COLORS.filter((c) => state.gemSupply[c] > 0);
    const k = Math.min(3, avail.length);
    const taken = emptyGemPool();
    for (const c of take3Colors) taken[c] += 1;
    const toggle = (c: Color) => {
      // Changing what's taken changes how much must go back — start over.
      setDiscard(emptyGemPool());
      setTake3Colors((prev) => {
        if (prev.includes(c)) return prev.filter((x) => x !== c);
        if (prev.length >= k) return prev;
        return [...prev, c];
      });
    };
    const ready = take3Colors.length > 0 && discardReady(taken);
    const applyTake3 = () => {
      if (!ready) return;
      onApply({
        type: 'take3',
        colors: take3Colors,
        discard: discardArg(taken),
      });
    };
    if (k === 0) {
      return <p className="picker-disabled">The gem supply is empty.</p>;
    }
    return (
      <>
        <p className="picker-hint">
          Click up to {k} different color{k === 1 ? '' : 's'}. Click again to
          deselect. Taking 1 or 2 is legal — that's how a swap at the 10-gem
          cap works.
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
        {renderDiscard(taken)}
        <button
          type="button"
          className="opp-apply"
          onClick={applyTake3}
          disabled={!ready}
        >
          Apply ({take3Colors.length === 0
            ? 'pick at least 1 color'
            : `take ${take3Colors.join(', ')}${
                discardTotal > 0 ? `, return ${describeDiscard()}` : ''
              }`})
        </button>
      </>
    );
  };

  const renderTake2 = () => {
    const eligible = COLORS.filter(
      (c) => state.gemSupply[c] >= TAKE_2_MIN_PILE,
    );
    if (eligible.length === 0) {
      return (
        <p className="picker-disabled">
          No color has ≥{TAKE_2_MIN_PILE} in supply — take 2 isn't legal.
        </p>
      );
    }
    const pick = (c: Color) => {
      // Under the cap this is still a one-click action; over it we need the
      // returns first.
      if (discardNeeded(takeTwoPool(c)) === 0) {
        onApply({ type: 'take2', color: c });
        return;
      }
      setDiscard(emptyGemPool());
      setTake2Color(c);
    };
    const pending = take2Color === null ? null : takeTwoPool(take2Color);
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
                className={`color-pick ${take2Color === c ? 'selected' : ''}`}
                style={{
                  background: COLOR_HEX[c],
                  color: c === 'white' ? '#1f2937' : '#fff',
                }}
                onClick={() => pick(c)}
                disabled={disabled}
                aria-label={`take2 ${c}`}
              >
                {c.charAt(0).toUpperCase()}
              </button>
            );
          })}
        </div>
        {take2Color !== null && pending !== null && (
          <>
            {renderDiscard(pending)}
            <button
              type="button"
              className="opp-apply"
              onClick={() => {
                if (!discardReady(pending)) return;
                onApply({
                  type: 'take2',
                  color: take2Color,
                  discard: discardArg(pending),
                });
              }}
              disabled={!discardReady(pending)}
            >
              Apply (take 2 {take2Color}
              {discardTotal > 0 ? `, return ${describeDiscard()}` : ''})
            </button>
          </>
        )}
      </>
    );
  };

  const renderReserve = () => {
    const taken = reservePool();
    const startReserve = (source: CardSource) => {
      if (discardNeeded(taken) === 0) {
        onApply({ type: 'reserve', source });
        return;
      }
      setDiscard(emptyGemPool());
      setPendingReserve(source);
    };
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
                        startReserve({ kind: 'faceUp', tier, slot: i })
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
                  onClick={() => startReserve({ kind: 'deck', tier })}
                >
                  Blind from T{tier}
                </button>
              </div>
            </div>
          ))}
        </div>
        {pendingReserve !== null && (
          <>
            {renderDiscard(taken)}
            <button
              type="button"
              className="opp-apply"
              onClick={() => {
                if (!discardReady(taken)) return;
                onApply({
                  type: 'reserve',
                  source: pendingReserve,
                  discard: discardArg(taken),
                });
              }}
              disabled={!discardReady(taken)}
            >
              Apply (reserve
              {discardTotal > 0 ? `, return ${describeDiscard()}` : ''})
            </button>
          </>
        )}
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
      const blind = r.reservedFrom === 'deck';
      const payment = computePayment(r.card, opp);
      if (blind) {
        // Always show blind reserves — the real card identity may have a
        // cheaper cost than the engine's guess, making it affordable when
        // the guess isn't. We re-check affordability after reveal.
        buyable.push({
          kind: 'reserve',
          card: r.card,
          index,
          payment: payment ?? { white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 },
          blind: true,
        });
      } else if (payment !== null) {
        buyable.push({
          kind: 'reserve',
          card: r.card,
          index,
          payment,
          blind: false,
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
                onClick={() => {
                  if (b.kind === 'reserve' && b.blind) {
                    // Defer the buy until the user picks the real identity.
                    onBuyBlindReserve(oppIdx, b.index, b.card.tier);
                    return;
                  }
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
                  );
                }}
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
              resetPicker();
            }}
          >
            {t === 'take3' ? 'Take 3' : t === 'take2' ? 'Take 2' : t === 'reserve' ? 'Reserve' : 'Buy'}
          </button>
        ))}
        <span className="opp-bar-spacer" />
        {!hideSuggestions && (
          <button
            type="button"
            className="opp-suggest-btn"
            onClick={onSuggest}
            disabled={thinking}
            title={`Run MCTS as if ${oppName} were choosing optimally`}
          >
            {thinking ? '…' : 'Suggest'}
          </button>
        )}
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
