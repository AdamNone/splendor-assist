import {
  GEM_COLORS,
  GEM_HAND_LIMIT,
  RESERVE_LIMIT,
  TAKE_2_MIN_PILE,
} from './types';
import type {
  Action,
  Card,
  GameState,
  GemPool,
  PlayerIndex,
  PlayerState,
} from './types';
import { meetsNobleRequirement, totalGems } from './gems';

const cloneState = (state: GameState): GameState => structuredClone(state);

const applyDiscard = (
  state: GameState,
  player: PlayerState,
  discard: GemPool | undefined,
): void => {
  const total = totalGems(player.gems);
  if (discard === undefined) {
    if (total > GEM_HAND_LIMIT) {
      throw new Error(
        `apply: player has ${total} gems (cap ${GEM_HAND_LIMIT}) but action carried no discard`,
      );
    }
    return;
  }
  for (const c of GEM_COLORS) {
    if (player.gems[c] < discard[c]) {
      throw new Error(
        `apply: cannot discard ${discard[c]} ${c}; player has only ${player.gems[c]}`,
      );
    }
    player.gems[c] -= discard[c];
    state.gemSupply[c] += discard[c];
  }
  const after = totalGems(player.gems);
  if (after > GEM_HAND_LIMIT) {
    throw new Error(
      `apply: player still over cap after discard (${after} > ${GEM_HAND_LIMIT})`,
    );
  }
};

const awardNobleIfAny = (state: GameState, player: PlayerState): void => {
  for (let i = 0; i < state.nobles.length; i++) {
    const noble = state.nobles[i];
    if (noble === undefined) continue;
    if (meetsNobleRequirement(player.bonuses, noble.requirement)) {
      player.nobles.push(noble);
      player.prestige += noble.prestige;
      state.nobles.splice(i, 1);
      return; // D7: at most one noble per turn
    }
  }
};

/**
 * Apply a player action and return the resulting state. Pure: never mutates
 * the input. Reveals from emptied face-up slots are queued in
 * `pendingReveals` rather than drawn — call `applyReveal` to consume them.
 *
 * Throws if the action is illegal w.r.t. the input state (callers should pull
 * actions from `legalActions` to avoid this).
 */
export const apply = (state: GameState, action: Action): GameState => {
  const next = cloneState(state);
  const player = next.players[next.currentPlayer];
  if (player === undefined) {
    throw new Error(`apply: invalid currentPlayer ${next.currentPlayer}`);
  }

  switch (action.type) {
    case 'take3': {
      for (const c of action.colors) {
        if (next.gemSupply[c] <= 0) {
          throw new Error(`apply: gem supply for ${c} is empty`);
        }
        next.gemSupply[c] -= 1;
        player.gems[c] += 1;
      }
      applyDiscard(next, player, action.discard);
      break;
    }

    case 'take2': {
      if (next.gemSupply[action.color] < TAKE_2_MIN_PILE) {
        throw new Error(
          `apply: take2 requires ≥${TAKE_2_MIN_PILE} ${action.color} in supply`,
        );
      }
      next.gemSupply[action.color] -= 2;
      player.gems[action.color] += 2;
      applyDiscard(next, player, action.discard);
      break;
    }

    case 'reserve': {
      if (player.reserved.length >= RESERVE_LIMIT) {
        throw new Error('apply: reserve limit reached');
      }
      let card: Card;
      if (action.source.kind === 'faceUp') {
        const { tier, slot } = action.source;
        const slots = next.faceUp[tier];
        const c = slots[slot];
        if (c === null || c === undefined) {
          throw new Error(`apply: face-up slot tier ${tier} #${slot} is empty`);
        }
        card = c;
        slots[slot] = null;
        next.pendingReveals.push({ tier, slot });
      } else {
        const { tier } = action.source;
        const top = next.decks[tier].shift();
        if (top === undefined) {
          throw new Error(`apply: tier ${tier} deck is empty`);
        }
        card = top;
      }
      player.reserved.push({ card, reservedFrom: action.source.kind });
      if (next.gemSupply.gold > 0) {
        next.gemSupply.gold -= 1;
        player.gems.gold += 1;
      }
      applyDiscard(next, player, action.discard);
      break;
    }

    case 'buy': {
      let card: Card;
      if (action.source.kind === 'faceUp') {
        const { tier, slot } = action.source;
        const slots = next.faceUp[tier];
        const c = slots[slot];
        if (c === null || c === undefined) {
          throw new Error(`apply: face-up slot tier ${tier} #${slot} is empty`);
        }
        card = c;
        slots[slot] = null;
        next.pendingReveals.push({ tier, slot });
      } else {
        const i = action.source.index;
        const reserved = player.reserved[i];
        if (reserved === undefined) {
          throw new Error(`apply: reserved index ${i} out of range`);
        }
        card = reserved.card;
        player.reserved.splice(i, 1);
      }
      for (const c of GEM_COLORS) {
        const owe = action.payment[c];
        if (player.gems[c] < owe) {
          throw new Error(
            `apply: cannot pay ${owe} ${c}; player has ${player.gems[c]}`,
          );
        }
        player.gems[c] -= owe;
        next.gemSupply[c] += owe;
      }
      player.purchased.push(card);
      player.bonuses[card.bonus] += 1;
      player.prestige += card.prestige;
      break;
    }
  }

  awardNobleIfAny(next, player);

  next.currentPlayer = ((next.currentPlayer + 1) % next.numPlayers) as PlayerIndex;
  next.turnNumber += 1;

  return next;
};

/**
 * Consume the first pending face-up reveal by drawing the top card of the
 * matching tier's deck. Returns a new state. If the deck is empty, the slot
 * stays null and the reveal is dropped.
 *
 * `sample` lets callers (Phase 3 MCTS / determinization) inject a chosen card
 * instead of drawing the deterministic top of the deck.
 */
export const applyReveal = (
  state: GameState,
  sample?: (deck: readonly Card[]) => Card | undefined,
): GameState => {
  if (state.pendingReveals.length === 0) return state;
  const next = cloneState(state);
  const reveal = next.pendingReveals.shift();
  if (reveal === undefined) return next;
  const deck = next.decks[reveal.tier];
  const drawer = sample ?? ((d) => d[0]);
  const card = drawer(deck);
  if (card === undefined) {
    // Deck exhausted — slot stays null. Standard rules treat this as expected.
    return next;
  }
  // Remove the chosen card from the deck (regardless of position chosen).
  const idx = deck.indexOf(card);
  if (idx >= 0) deck.splice(idx, 1);
  next.faceUp[reveal.tier][reveal.slot] = card;
  return next;
};

/** Apply every queued reveal deterministically (deck top first). */
export const applyAllReveals = (state: GameState): GameState => {
  let s = state;
  while (s.pendingReveals.length > 0) s = applyReveal(s);
  return s;
};

/** Convenience: apply an action and immediately resolve any queued reveals. */
export const applyTurn = (state: GameState, action: Action): GameState =>
  applyAllReveals(apply(state, action));

/**
 * D6: a Splendor game ends at the *end of a round* (every player having had
 * an equal number of turns) once at least one player has reached 15 prestige.
 * After applying any action, `currentPlayer` has just advanced to whoever is
 * next; if that's the player who started the game, a round just completed.
 */
export const isTerminal = (state: GameState): boolean => {
  if (state.turnNumber === 0) return false;
  if (state.currentPlayer !== state.startingPlayer) return false;
  return state.players.some((p) => p.prestige >= 15);
};

/**
 * Pick the winning player index. Tiebreaker: fewer purchased cards.
 * Behavior is undefined unless `isTerminal(state)` — callers should check.
 */
export const winner = (state: GameState): PlayerIndex => {
  let bestIdx: PlayerIndex = 0;
  let bestPrestige = -Infinity;
  let bestCardCount = Infinity;
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p === undefined) continue;
    if (
      p.prestige > bestPrestige ||
      (p.prestige === bestPrestige && p.purchased.length < bestCardCount)
    ) {
      bestPrestige = p.prestige;
      bestCardCount = p.purchased.length;
      bestIdx = i as PlayerIndex;
    }
  }
  return bestIdx;
};
