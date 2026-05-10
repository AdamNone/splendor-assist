import { describe, expect, it } from 'vitest';
import {
  concentrationFeature,
  evaluate,
  evaluateBaseline,
  evaluateV2,
  nobleProximityFeature,
  TERMINAL_LOSS,
  TERMINAL_WIN,
} from './evaluate';
import { card, makeState, noble, player } from './fixtures';

describe('evaluate', () => {
  it('a fresh player has score 0', () => {
    const s = makeState({ players: [player(), player()] });
    expect(evaluateBaseline(s, 0)).toBe(0);
  });

  it('rewards prestige one-for-one', () => {
    const s = makeState({ players: [player({ prestige: 7 }), player()] });
    expect(evaluateBaseline(s, 0)).toBe(7);
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
    expect(evaluateBaseline(s, 0)).toBeCloseTo(2.0, 5);
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
    expect(evaluateBaseline(s, 0)).toBeCloseTo(4.5, 5);
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

describe('noble proximity feature', () => {
  it('returns 0 when player has no bonuses', () => {
    const n = noble('N-1', { white: 4, blue: 4 });
    const s = makeState({ nobles: [n], players: [player(), player()] });
    expect(nobleProximityFeature(s, 0)).toBe(0);
  });

  it('halfway to a 4+4 noble scores 1.5 (half of 3)', () => {
    const n = noble('N-1', { white: 4, blue: 4 });
    const c = card('T1-001', 1, 'white');
    // 4 white bonuses, 0 blue: need=4, maxNeed=8, proximity=4, score=3*(4/8)=1.5
    const s = makeState({
      nobles: [n],
      players: [player({ purchased: [c, c, c, c] }), player()],
    });
    expect(nobleProximityFeature(s, 0)).toBeCloseTo(1.5, 5);
  });

  it('summing across multiple nobles', () => {
    const n1 = noble('N-1', { white: 4, blue: 4 });
    const n2 = noble('N-2', { white: 4, red: 4 });
    const c = card('T1-001', 1, 'white');
    // 4 white: contributes 1.5 to each noble
    const s = makeState({
      nobles: [n1, n2],
      players: [player({ purchased: [c, c, c, c] }), player()],
    });
    expect(nobleProximityFeature(s, 0)).toBeCloseTo(3.0, 5);
  });

  it('full noble gives full 3.0 (the moment before claim)', () => {
    const n = noble('N-1', { white: 1 });
    const c = card('T1-001', 1, 'white');
    const s = makeState({
      nobles: [n],
      players: [player({ purchased: [c] }), player()],
    });
    expect(nobleProximityFeature(s, 0)).toBeCloseTo(3.0, 5);
  });
});

describe('v2 evaluator includes noble proximity', () => {
  it('scores higher than baseline when player is making noble progress', () => {
    const n = noble('N-1', { white: 4, blue: 4 });
    const c = card('T1-001', 1, 'white');
    const s = makeState({
      nobles: [n],
      players: [player({ purchased: [c, c] }), player()],
    });
    expect(evaluateV2(s, 0)).toBeGreaterThan(evaluateBaseline(s, 0));
  });
});

describe('concentration feature', () => {
  it('returns 0 when player has no bonuses', () => {
    const s = makeState({ players: [player(), player()] });
    expect(concentrationFeature(s, 0)).toBe(0);
  });

  it('a flat 1-of-each engine has top2 = 2', () => {
    const w = card('CW', 1, 'white');
    const b = card('CB', 1, 'blue');
    const g = card('CG', 1, 'green');
    const r = card('CR', 1, 'red');
    const k = card('CK', 1, 'black');
    const s = makeState({ players: [player({ purchased: [w, b, g, r, k] }), player()] });
    expect(concentrationFeature(s, 0)).toBe(2);
  });

  it('a 4+4 noble-shaped engine has top2 = 8', () => {
    const w = card('CW', 1, 'white');
    const b = card('CB', 1, 'blue');
    const s = makeState({
      players: [player({ purchased: [w, w, w, w, b, b, b, b] }), player()],
    });
    expect(concentrationFeature(s, 0)).toBe(8);
  });

  it('an over-concentrated single color stops at top2 = max + 0', () => {
    const w = card('CW', 1, 'white');
    const s = makeState({
      players: [player({ purchased: [w, w, w, w, w] }), player()],
    });
    expect(concentrationFeature(s, 0)).toBe(5);
  });
});

describe('current evaluator alias', () => {
  it('evaluate alias points at v2 (concentration was rolled back; see diary Experiment 3)', () => {
    const c = card('CW', 1, 'white');
    const s = makeState({ players: [player({ purchased: [c, c] }), player()] });
    expect(evaluate(s, 0)).toBe(evaluateV2(s, 0));
  });
});
