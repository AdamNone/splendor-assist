import { describe, expect, it } from 'vitest';
import {
  concentrationFeature,
  engineValueFeature,
  evaluate,
  evaluateBaseline,
  evaluateV2,
  evaluateV3,
  gemPressureFeature,
  nobleProximityFeature,
  opponentThreatFeature,
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

describe('engine value feature', () => {
  it('returns 0 when no demand exists in play', () => {
    const s = makeState({ players: [player(), player()] });
    expect(engineValueFeature(s, 0)).toBe(0);
  });

  it('with uniformly-demanded colors, equals bonus_count', () => {
    // Build a state where each visible card costs 1 of each color so demand
    // is uniform; then a player with 4 bonuses should score 4.0.
    const c = card('CV', 1, 'white', 0, { white: 1, blue: 1, green: 1, red: 1, black: 1 });
    const w = card('CW', 1, 'white');
    const s = makeState({
      faceUp: { 1: [c, c, c, c] },
      players: [player({ purchased: [w, w, w, w] }), player()],
    });
    expect(engineValueFeature(s, 0)).toBeCloseTo(4.0, 5);
  });

  it('rewards bonuses in over-demanded colors more than under-demanded', () => {
    // All face-up cards demand only red. A player with 1 red bonus should
    // score ≥ a player with 1 white bonus.
    const allRed = card('CR', 1, 'green', 0, { red: 4 });
    const wCard = card('CW', 1, 'white');
    const rCard = card('CR2', 1, 'red');
    const s = makeState({
      faceUp: { 1: [allRed, allRed, allRed, allRed] },
      players: [
        player({ purchased: [wCard] }), // white bonus, but no white demand
        player({ purchased: [rCard] }), // red bonus, lots of red demand
      ],
    });
    expect(engineValueFeature(s, 1)).toBeGreaterThan(engineValueFeature(s, 0));
  });
});

describe('gem pressure feature', () => {
  it('returns 0 below the 7-gem threshold', () => {
    const s = makeState({
      players: [
        player({ gems: { white: 3, blue: 2, green: 1, red: 0, black: 1, gold: 0 } }),
        player(),
      ],
    });
    expect(gemPressureFeature(s, 0)).toBe(0);
  });

  it('returns -1, -2, -3 at 8, 9, 10 gems', () => {
    const at = (n: number) =>
      makeState({
        players: [
          player({ gems: { white: n, blue: 0, green: 0, red: 0, black: 0, gold: 0 } }),
          player(),
        ],
      });
    expect(gemPressureFeature(at(8), 0)).toBe(-1);
    expect(gemPressureFeature(at(9), 0)).toBe(-2);
    expect(gemPressureFeature(at(10), 0)).toBe(-3);
  });
});

describe('opponent threat feature', () => {
  it('returns 0 with no opponents who can afford anything', () => {
    const s = makeState({ players: [player(), player()] });
    expect(opponentThreatFeature(s, 0)).toBe(0);
  });

  it('penalizes prestige of cards an opponent can afford', () => {
    const cheap = card('T1-001', 1, 'white', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [cheap, null, null, null] },
      players: [
        player(),
        player({ gems: { white: 0, blue: 1, green: 0, red: 0, black: 0, gold: 0 } }),
      ],
    });
    expect(opponentThreatFeature(s, 0)).toBe(-1);
  });

  it('changes when player buys a card the opponent could have bought', () => {
    const cheap = card('T1-001', 1, 'white', 1, { blue: 1 });
    const before = makeState({
      faceUp: { 1: [cheap, null, null, null] },
      players: [
        player(),
        player({ gems: { white: 0, blue: 1, green: 0, red: 0, black: 0, gold: 0 } }),
      ],
    });
    const after = makeState({
      faceUp: { 1: [null, null, null, null] },
      players: [
        player(),
        player({ gems: { white: 0, blue: 1, green: 0, red: 0, black: 0, gold: 0 } }),
      ],
    });
    expect(opponentThreatFeature(after, 0)).toBeGreaterThan(opponentThreatFeature(before, 0));
  });
});

describe('v3 evaluator includes opponent threat', () => {
  it('scores higher than v2 when opponents have many threats blocked', () => {
    const cheap = card('T1-001', 1, 'white', 1, { blue: 1 });
    const board = makeState({
      faceUp: { 1: [cheap, cheap, cheap, cheap] },
      players: [
        player(),
        player({ gems: { white: 0, blue: 4, green: 0, red: 0, black: 0, gold: 0 } }),
      ],
    });
    // v3 penalizes the threats; v2 doesn't see them. So evaluateV2 > evaluateV3 here.
    expect(evaluateV2(board, 0)).toBeGreaterThan(evaluateV3(board, 0));
  });
});

describe('current evaluator alias', () => {
  it('evaluate alias points at v3 (opponent_threat is the current best)', () => {
    const c = card('CW', 1, 'white');
    const s = makeState({ players: [player({ purchased: [c, c] }), player()] });
    expect(evaluate(s, 0)).toBe(evaluateV3(s, 0));
  });
});
