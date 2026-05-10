import {
  COLORS,
  RESERVE_LIMIT,
  TAKE_2_MIN_PILE,
  TIERS,
} from './types';
import type { Action, Color, GameState } from './types';
import { computePayment } from './gems';

const kSubsets = <T>(items: readonly T[], k: number): T[][] => {
  const result: T[][] = [];
  const picked: T[] = [];
  const rec = (start: number) => {
    if (picked.length === k) {
      result.push(picked.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      const item = items[i];
      if (item === undefined) continue;
      picked.push(item);
      rec(i + 1);
      picked.pop();
    }
  };
  rec(0);
  return result;
};

export const legalActions = (state: GameState): Action[] => {
  const actions: Action[] = [];
  const player = state.players[state.currentPlayer];
  if (player === undefined) return actions;

  const availableColors: Color[] = COLORS.filter((c) => state.gemSupply[c] > 0);
  const takeSize = Math.min(3, availableColors.length);
  if (takeSize > 0) {
    for (const subset of kSubsets(availableColors, takeSize)) {
      actions.push({ type: 'take3', colors: subset });
    }
  }

  for (const c of COLORS) {
    if (state.gemSupply[c] >= TAKE_2_MIN_PILE) {
      actions.push({ type: 'take2', color: c });
    }
  }

  if (player.reserved.length < RESERVE_LIMIT) {
    for (const tier of TIERS) {
      const slots = state.faceUp[tier];
      for (let slot = 0; slot < slots.length; slot++) {
        if (slots[slot] !== null && slots[slot] !== undefined) {
          actions.push({ type: 'reserve', source: { kind: 'faceUp', tier, slot } });
        }
      }
      if (state.decks[tier].length > 0) {
        actions.push({ type: 'reserve', source: { kind: 'deck', tier } });
      }
    }
  }

  for (const tier of TIERS) {
    const slots = state.faceUp[tier];
    for (let slot = 0; slot < slots.length; slot++) {
      const card = slots[slot];
      if (card === null || card === undefined) continue;
      const payment = computePayment(card, player);
      if (payment !== null) {
        actions.push({ type: 'buy', source: { kind: 'faceUp', tier, slot }, payment });
      }
    }
  }
  for (let i = 0; i < player.reserved.length; i++) {
    const reserved = player.reserved[i];
    if (reserved === undefined) continue;
    const payment = computePayment(reserved.card, player);
    if (payment !== null) {
      actions.push({ type: 'buy', source: { kind: 'reserve', index: i }, payment });
    }
  }

  return actions;
};
