import { describe, expect, it } from 'vitest';
import { evaluate, TERMINAL_LOSS, TERMINAL_WIN } from './evaluate';
import { card, makeState, player } from './fixtures';

describe('evaluate', () => {
  it('a fresh player has score 0', () => {
    const s = makeState({ players: [player(), player()] });
    expect(evaluate(s, 0)).toBe(0);
  });

  it('rewards prestige one-for-one', () => {
    const s = makeState({ players: [player({ prestige: 7 }), player()] });
    expect(evaluate(s, 0)).toBe(7);
  });

  it('rewards bonuses at half the rate of prestige', () => {
    const c = card('T1-001', 1, 'white');
    const s = makeState({
      players: [
        // 4 white bonuses worth 2.0; auto-derived by the player fixture
        player({ purchased: [c, c, c, c] }),
        player(),
      ],
    });
    // Note: prestige is auto-derived too; the bonus cards have prestige 0,
    // so the player's prestige stays 0 and we see exactly the bonus term.
    expect(evaluate(s, 0)).toBeCloseTo(2.0, 5);
  });

  it('combines prestige and bonus terms additively', () => {
    const c = card('T1-001', 1, 'red', 1);
    const s = makeState({
      players: [
        // 3 cards each worth 1 prestige and a red bonus → 3p + 1.5 = 4.5
        player({ purchased: [c, c, c] }),
        player(),
      ],
    });
    expect(evaluate(s, 0)).toBeCloseTo(4.5, 5);
  });

  it('returns terminal-win for the winner at game end', () => {
    const s = makeState({
      players: [player({ prestige: 16 }), player({ prestige: 14 })],
      currentPlayer: 0,
      startingPlayer: 0,
      turnNumber: 4,
    });
    expect(evaluate(s, 0)).toBe(TERMINAL_WIN);
    expect(evaluate(s, 1)).toBe(TERMINAL_LOSS);
  });

  it('returns terminal-loss for non-winners even when their prestige is high', () => {
    const s = makeState({
      players: [player({ prestige: 16 }), player({ prestige: 17 })],
      currentPlayer: 0,
      startingPlayer: 0,
      turnNumber: 4,
    });
    // Player 1 has more prestige -> wins. Player 0 loses despite 16 prestige.
    expect(evaluate(s, 0)).toBe(TERMINAL_LOSS);
    expect(evaluate(s, 1)).toBe(TERMINAL_WIN);
  });
});
