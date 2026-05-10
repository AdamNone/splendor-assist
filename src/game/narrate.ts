import { COLORS, GEM_COLORS } from './types';
import type { Action, Color, GameState, GemPool } from './types';

const colorAbbrev: Record<Color, string> = {
  white: 'W',
  blue: 'B',
  green: 'G',
  red: 'R',
  black: 'K',
};

const formatGems = (g: GemPool): string => {
  const parts: string[] = [];
  for (const c of GEM_COLORS) {
    if (g[c] > 0) parts.push(`${g[c]}${c === 'gold' ? 'g' : colorAbbrev[c]}`);
  }
  return parts.length === 0 ? '∅' : parts.join(' ');
};

const cardSummary = (
  state: GameState,
  src: { kind: 'faceUp'; tier: 1 | 2 | 3; slot: number } | { kind: 'reserve'; index: number },
  player: number,
): string => {
  if (src.kind === 'faceUp') {
    const c = state.faceUp[src.tier][src.slot];
    if (!c) return `T${src.tier}-?`;
    return `${c.id} (${c.prestige}p, +${c.bonus})`;
  }
  const r = state.players[player]?.reserved[src.index];
  if (!r) return 'reserve-?';
  return `${r.card.id} (${r.card.prestige}p, +${r.card.bonus})`;
};

/** Format one turn for human reading. Pass the pre-action state so source slots can be resolved. */
export const narrate = (before: GameState, action: Action): string => {
  const turn = before.turnNumber;
  const p = before.currentPlayer;
  const tag = `T${turn} P${p}`;
  switch (action.type) {
    case 'take3': {
      const cs = action.colors.map((c) => colorAbbrev[c]).join('+');
      return `${tag} take3 ${cs}`;
    }
    case 'take2':
      return `${tag} take2 ${colorAbbrev[action.color]}${colorAbbrev[action.color]}`;
    case 'reserve': {
      if (action.source.kind === 'faceUp') {
        return `${tag} reserve ${cardSummary(before, action.source, p)}`;
      }
      return `${tag} reserve blind from tier ${action.source.tier}`;
    }
    case 'buy': {
      const summary = cardSummary(before, action.source, p);
      const paid = formatGems(action.payment);
      return `${tag} buy ${summary} paying ${paid}`;
    }
  }
};

/** Compact one-liner of the player's tableau: prestige, bonuses, gems. */
export const formatPlayer = (state: GameState, idx: number): string => {
  const p = state.players[idx];
  if (!p) return `P${idx}: ?`;
  const bonuses = COLORS.map((c) =>
    p.bonuses[c] > 0 ? `${p.bonuses[c]}${colorAbbrev[c]}` : null,
  )
    .filter((s) => s !== null)
    .join(' ');
  const reserved = p.reserved.length > 0 ? ` reserve=${p.reserved.length}` : '';
  return `P${idx}: ${p.prestige}p [${bonuses || '–'}] gems=${formatGems(p.gems)}${reserved}`;
};

/** End-of-game summary: winner index, both player tableaus, turn count. */
export const formatGameEnd = (state: GameState, winnerIdx: number): string => {
  const lines = [
    `Game over after ${state.turnNumber} turns. Winner: P${winnerIdx}.`,
    ...state.players.map((_, i) => '  ' + formatPlayer(state, i)),
  ];
  return lines.join('\n');
};
