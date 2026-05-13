import { useEffect, useMemo, useRef, useState } from 'react';
// useMemo is used inside CardPickerModal below.
import { apply } from './game/apply';
import { computePayment } from './game/gems';
import { mctsBestActionWithStats } from './game/mcts';
import type { MctsCandidate } from './game/mcts';
import { evaluateV3 } from './game/evaluate';
import { ALL_CARDS, ALL_NOBLES } from './game/data';
import { narrate } from './game/narrate';
import { seededRng } from './game/setup';
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

type PlayerForm = {
  bonuses: ColorCount;
  gems: GemPool;
  prestige: number;
};

type FaceUpGrid = Record<Tier, Array<Card | null>>;

type AssistantState = {
  numPlayers: 2 | 3 | 4;
  currentPlayer: PlayerIndex;
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
};

const defaultPlayerName = (idx: number): string => `P${idx}`;

const emptyPlayer = (): PlayerForm => ({
  bonuses: emptyColorCount(),
  gems: emptyGemPool(),
  prestige: 0,
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
      return {
        ...parsed,
        mainPlayer: (parsed.mainPlayer ?? 0) as PlayerIndex,
        playerNames: Array.isArray(parsed.playerNames) ? parsed.playerNames : [],
        faceUp: rehydrateGrid(parsed.faceUp),
        nobles: parsed.nobles
          .map((n) => noblesById.get(n.id))
          .filter((n): n is Noble => n !== undefined),
      };
    }
  } catch {
    /* fall through to fresh */
  }
  return {
    numPlayers: 2,
    currentPlayer: 0,
    mainPlayer: 0,
    playerNames: [],
    gemSupply: { ...GEM_SUPPLY_DEFAULT[2] },
    faceUp: emptyFaceUp(),
    nobles: [],
    players: [emptyPlayer(), emptyPlayer()],
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
  mainPlayer: prev.mainPlayer,
  playerNames: prev.playerNames,
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
  })),
});

const buildGameState = (s: AssistantState): GameState => {
  const used = new Set<string>();
  for (const tier of TIERS) {
    for (const slot of s.faceUp[tier]) {
      if (slot !== null) used.add(slot.id);
    }
  }
  // Decks = remaining cards of that tier minus what's face-up. We don't
  // model purchased cards explicitly (bonuses/prestige are entered directly),
  // so the deck count is slightly overstated by the count of cards already
  // bought — this matters very little for MCTS-with-rollouts.
  const decks = {
    1: ALL_CARDS.filter((c) => c.tier === 1 && !used.has(c.id)),
    2: ALL_CARDS.filter((c) => c.tier === 2 && !used.has(c.id)),
    3: ALL_CARDS.filter((c) => c.tier === 3 && !used.has(c.id)),
  };
  const players: PlayerState[] = s.players.slice(0, s.numPlayers).map((p) => ({
    gems: { ...p.gems },
    purchased: [],
    reserved: [],
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
    startingPlayer: 0,
    pendingReveals: [],
    turnNumber: 0,
  };
};

const describeAction = (state: GameState, action: Action): string => {
  return narrate(state, action);
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

  const setSupplyGem = (c: GemColor, value: number) => {
    setS((prev) => ({ ...prev, gemSupply: { ...prev.gemSupply, [c]: Math.max(0, value) } }));
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

  const setPlayerBonus = (idx: number, c: Color, value: number) => {
    setS((prev) => {
      const players = prev.players.slice();
      const p = players[idx];
      if (p === undefined) return prev;
      players[idx] = { ...p, bonuses: { ...p.bonuses, [c]: Math.max(0, value) } };
      return { ...prev, players };
    });
  };

  const setPlayerGem = (idx: number, c: GemColor, value: number) => {
    setS((prev) => {
      const players = prev.players.slice();
      const p = players[idx];
      if (p === undefined) return prev;
      players[idx] = { ...p, gems: { ...p.gems, [c]: Math.max(0, value) } };
      return { ...prev, players };
    });
  };

  const setPlayerPrestige = (idx: number, value: number) => {
    setS((prev) => {
      const players = prev.players.slice();
      const p = players[idx];
      if (p === undefined) return prev;
      players[idx] = { ...p, prestige: Math.max(0, value) };
      return { ...prev, players };
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
      mainPlayer: prev.mainPlayer,
      playerNames: prev.playerNames.slice(),
      gemSupply: { ...GEM_SUPPLY_DEFAULT[prev.numPlayers] },
      faceUp: emptyFaceUp(),
      nobles: [],
      players: Array.from({ length: prev.numPlayers }, emptyPlayer),
    }));
    setRecommendation(null);
    setErrors([]);
  };

  // ===== Validation =====

  const validate = (): string[] => {
    const issues: string[] = [];
    let totalFaceUp = 0;
    for (const tier of TIERS) for (const slot of s.faceUp[tier]) if (slot) totalFaceUp += 1;
    if (totalFaceUp < 4) issues.push(`Only ${totalFaceUp} face-up cards entered (expect up to 12).`);
    if (s.nobles.length === 0) issues.push('No nobles entered on the board.');
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
    setThinking(true);
    setRecommendation(null);
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
  const onApply = (action: Action) => {
    try {
      const state = buildGameState(s);
      const next = apply(state, action);
      pushHistory(s);
      setS((prev) => fromGameState(next, prev));
      setRecommendation(null);
      setErrors([]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors([`Apply failed: ${message}`]);
    }
  };

  // ===== Auto-recommend =====

  const stateForEffect = s; // explicit so the effect can depend on the whole object
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Cancel any pending auto-run if state changed mid-debounce.
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
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
  ]);

  // ===== Render helpers =====

  const visibleNobles = ALL_NOBLES;

  // Card IDs already assigned to a face-up slot. The picker uses this to
  // grey out cards the user already placed elsewhere, so the same physical
  // card can't be selected twice.
  const usedFaceUpIds = useMemo(() => {
    const set = new Set<string>();
    for (const tier of TIERS) {
      for (const c of s.faceUp[tier]) {
        if (c !== null) set.add(c.id);
      }
    }
    return set;
  }, [s.faceUp]);

  // ===== Render =====

  const currentVisibleFaceUp = (tier: Tier) =>
    s.faceUp[tier].filter((c) => c !== null).length;

  return (
    <div className="assistant">
      <header>
        <div className="header-row">
          <div>
            <h1>Splendor Assistant</h1>
            <p className="sub">
              Click a recommendation when it's your turn; pick the opponent's
              action when it isn't. The engine enforces all rules so illegal
              moves can't be entered. State persists between sessions.
            </p>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="undo-btn"
              onClick={onUndo}
              disabled={history.length === 0}
              title={history.length === 0 ? 'Nothing to undo' : 'Restore the previous state'}
            >
              ↶ Undo
            </button>
            <button type="button" className="new-game-btn" onClick={resetGame}>
              New game
            </button>
          </div>
        </div>
      </header>

      <section className="card setup">
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
          <label>Whose turn</label>
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
          <label>You are</label>
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
      </section>

      <section className="card">
        <h2>Gem supply</h2>
        <div className="gem-row">
          {GEM_COLORS.map((c) => (
            <div key={c} className="gem-cell">
              <div
                className="swatch"
                style={{ background: c === 'gold' ? GOLD_HEX : COLOR_HEX[c] }}
                title={c}
              />
              <StepCounter
                value={s.gemSupply[c]}
                onChange={(v) => setSupplyGem(c, v)}
                ariaLabel={`supply ${c}`}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Face-up cards</h2>
        <p className="hint">
          Click a slot to pick from that tier's cards. The picker shows every
          card visually (bonus color, prestige, cost) so you can match the
          physical card at a glance.
        </p>
        {TIERS.slice().reverse().map((tier) => (
          <div key={tier} className="faceup-row tier-row">
            <span className="faceup-label">T{tier}</span>
            <div className="faceup-tiles">
              {s.faceUp[tier].map((card, i) => (
                <CardSlot
                  key={i}
                  tier={tier}
                  card={card}
                  unavailableIds={usedFaceUpIds}
                  onPick={(picked) => {
                    setS((prev) => {
                      const grid = { ...prev.faceUp, [tier]: prev.faceUp[tier].slice() };
                      grid[tier][i] = picked;
                      return { ...prev, faceUp: grid };
                    });
                  }}
                />
              ))}
            </div>
            <span className="faceup-count">{currentVisibleFaceUp(tier)} / 4</span>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Nobles on the board</h2>
        <p className="hint">
          Click to toggle (up to {s.numPlayers + 1}). Standard rules deal
          numPlayers + 1.
        </p>
        <div className="noble-grid">
          {visibleNobles.map((n) => {
            const selected = s.nobles.some((x) => x.id === n.id);
            return (
              <button
                key={n.id}
                type="button"
                className={`noble-card ${selected ? 'selected' : ''}`}
                onClick={() => toggleNoble(n)}
                title={describeNobleRequirement(n)}
              >
                <span className="noble-id">{n.id}</span>
                <span className="noble-req">{describeNobleRequirement(n)}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h2>Player tableaus</h2>
        {s.players.slice(0, s.numPlayers).map((p, idx) => (
          <PlayerPanel
            key={idx}
            idx={idx}
            name={s.playerNames[idx] ?? ''}
            isCurrent={idx === s.currentPlayer}
            player={p}
            onName={(name) => setPlayerName(idx, name)}
            onBonus={(c, v) => setPlayerBonus(idx, c, v)}
            onGem={(c, v) => setPlayerGem(idx, c, v)}
            onPrestige={(v) => setPlayerPrestige(idx, v)}
          />
        ))}
      </section>

      <section className="card recommend">
        {s.currentPlayer !== s.mainPlayer ? (
          <OpponentTurnPanel
            assistantState={s}
            playerLabel={playerLabel}
            onApply={onApply}
            onSkip={() => setCurrentPlayer(s.mainPlayer)}
            errors={errors}
          />
        ) : (
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
            {recommendation && (
              <div className="recommendation">
                <button
                  type="button"
                  className="rec-option recommended"
                  onClick={() => onApply(recommendation.bestAction)}
                  disabled={thinking}
                >
                  <div className="rec-option-left">
                    <span className="rec-option-tag">Recommended</span>
                    <span className="rec-option-summary">
                      {namifyNarration(recommendation.summary)}
                    </span>
                  </div>
                  <span className="rec-option-cta">Click to apply →</span>
                </button>

                <div className="winrates">
                  <div className="winrates-title">
                    Estimated win chance (Monte-Carlo, not calibrated)
                  </div>
                  {recommendation.winRates.map((rate, i) => {
                    const pct = Math.max(0, Math.min(1, rate)) * 100;
                    const isMe = i === recommendation.currentPlayer;
                    return (
                      <div
                        key={i}
                        className={`winrate-row ${isMe ? 'me' : ''}`}
                      >
                        <span className="winrate-label">
                          {playerLabel(i)}{isMe ? ' (to move)' : ''}
                        </span>
                        <div className="winrate-bar">
                          <div
                            className="winrate-fill"
                            style={{ width: `${pct.toFixed(1)}%` }}
                          />
                        </div>
                        <span className="winrate-value">{pct.toFixed(0)}%</span>
                      </div>
                    );
                  })}
                </div>

                {recommendation.alternatives.length > 0 && (
                  <div className="alternatives">
                    <div className="alt-title">Or pick a different move</div>
                    {recommendation.alternatives.map((a, i) => (
                      <button
                        key={i}
                        type="button"
                        className="rec-option alt"
                        onClick={() => onApply(a.action)}
                        disabled={thinking}
                      >
                        <span className="rec-option-summary">
                          {namifyNarration(a.summary)}
                        </span>
                        <span className="alt-meta">
                          {(a.meanReward * 100).toFixed(0)}% · {a.visits} visits
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="rec-meta">
                  MCTS · {recommendation.rootVisits} iter · {recommendation.thinkingMs} ms
                </div>
              </div>
            )}
          </>
        )}
      </section>
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
}: {
  tier: Tier;
  card: Card | null;
  onPick: (card: Card | null) => void;
  unavailableIds: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`card-slot ${card ? 'filled' : 'empty'}`}
        onClick={() => setOpen(true)}
        aria-label={`face-up tier ${tier} slot ${card ? card.id : 'empty'}`}
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
}: {
  tier: Tier;
  selected: Card | null;
  unavailableIds: Set<string>;
  onPick: (card: Card | null) => void;
  onClose: () => void;
}) {
  const cards = useMemo(
    () => ALL_CARDS.filter((c) => c.tier === tier),
    [tier],
  );

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
          <h3>Tier {tier} cards</h3>
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
              const isUnavailable = unavailableIds.has(c.id) && !isSelected;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`picker-tile ${isSelected ? 'selected' : ''} ${isUnavailable ? 'unavailable' : ''}`}
                  onClick={() => {
                    if (!isUnavailable) onPick(c);
                  }}
                  disabled={isUnavailable}
                  title={isUnavailable ? `${c.id} — already placed in another slot` : c.id}
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

function StepCounter({
  value,
  onChange,
  ariaLabel,
  min = 0,
}: {
  value: number;
  onChange: (v: number) => void;
  ariaLabel: string;
  min?: number;
}) {
  return (
    <div className="stepper">
      <button
        type="button"
        className="step-btn"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label={`decrement ${ariaLabel}`}
        tabIndex={-1}
      >
        −
      </button>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))}
        onFocus={(e) => e.target.select()}
        aria-label={ariaLabel}
        className="step-input"
      />
      <button
        type="button"
        className="step-btn"
        onClick={() => onChange(value + 1)}
        aria-label={`increment ${ariaLabel}`}
        tabIndex={-1}
      >
        +
      </button>
    </div>
  );
}

function PlayerPanel({
  idx,
  name,
  isCurrent,
  player,
  onName,
  onBonus,
  onGem,
  onPrestige,
}: {
  idx: number;
  name: string;
  isCurrent: boolean;
  player: PlayerForm;
  onName: (name: string) => void;
  onBonus: (c: Color, v: number) => void;
  onGem: (c: GemColor, v: number) => void;
  onPrestige: (v: number) => void;
}) {
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
      </div>
      <div className="player-row">
        <span className="player-label">Bonuses</span>
        <div className="gem-row">
          {COLORS.map((c) => (
            <div key={c} className="gem-cell">
              <div className="swatch" style={{ background: COLOR_HEX[c] }} />
              <StepCounter
                value={player.bonuses[c]}
                onChange={(v) => onBonus(c, v)}
                ariaLabel={`P${idx} bonus ${c}`}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="player-row">
        <span className="player-label">Gems</span>
        <div className="gem-row">
          {GEM_COLORS.map((c) => (
            <div key={c} className="gem-cell">
              <div
                className="swatch"
                style={{ background: c === 'gold' ? GOLD_HEX : COLOR_HEX[c] }}
              />
              <StepCounter
                value={player.gems[c]}
                onChange={(v) => onGem(c, v)}
                ariaLabel={`P${idx} gem ${c}`}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="player-row">
        <span className="player-label">Prestige</span>
        <StepCounter
          value={player.prestige}
          onChange={onPrestige}
          ariaLabel={`P${idx} prestige`}
        />
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
  onSkip,
  errors,
}: {
  assistantState: AssistantState;
  playerLabel: (idx: number) => string;
  onApply: (action: Action) => void;
  onSkip: () => void;
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
    const buyable: Array<{ card: Card; tier: Tier; slot: number; payment: GemPool }> = [];
    for (const tier of TIERS) {
      for (let slot = 0; slot < state.faceUp[tier].length; slot++) {
        const card = state.faceUp[tier][slot];
        if (card === null || card === undefined) continue;
        const payment = computePayment(card, opp);
        if (payment !== null) {
          buyable.push({ card, tier, slot, payment });
        }
      }
    }
    if (buyable.length === 0) {
      return (
        <p className="picker-disabled">
          {oppName} can't afford any face-up card. (Buying from their own
          reserve isn't tracked in v0.4 — edit manually if it happens.)
        </p>
      );
    }
    return (
      <>
        <p className="picker-hint">
          Pick the card {oppName} bought. Only cards they can afford are
          shown; payment is computed automatically.
        </p>
        <div className="picker-buy-grid">
          {buyable.map((b) => (
            <button
              key={`${b.tier}-${b.slot}`}
              type="button"
              className="picker-card-btn"
              onClick={() =>
                onApply({
                  type: 'buy',
                  source: { kind: 'faceUp', tier: b.tier, slot: b.slot },
                  payment: b.payment,
                })
              }
              aria-label={`buy ${b.card.id}`}
            >
              <CardArt card={b.card} size="small" />
            </button>
          ))}
        </div>
      </>
    );
  };

  return (
    <div className="opponent-panel">
      <div className="opp-header">
        <div>
          <div className="opp-title">{oppName}'s turn — what did they do?</div>
          <p className="opp-sub">
            All actions go through the engine, so illegal moves can't be
            entered here. Edit their tableau above manually only for
            unusual cases (discarding from over-cap, buying from their own
            reserve, etc.).
          </p>
        </div>
        <button type="button" className="opp-skip-btn" onClick={onSkip}>
          Skip {oppName} (they passed) →
        </button>
      </div>

      {errors.length > 0 && (
        <div className="issues">
          {errors.map((e, i) => (
            <div key={i}>⚠ {e}</div>
          ))}
        </div>
      )}

      <div className="opp-type-row">
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
            {t === 'take3' ? 'Take 3 different'
              : t === 'take2' ? 'Take 2 same'
              : t === 'reserve' ? 'Reserve'
              : 'Buy'}
          </button>
        ))}
      </div>

      <div className="opp-picker-area">
        {actionType === null && (
          <p className="picker-hint">Pick an action type above.</p>
        )}
        {actionType === 'take3' && renderTake3()}
        {actionType === 'take2' && renderTake2()}
        {actionType === 'reserve' && renderReserve()}
        {actionType === 'buy' && renderBuy()}
      </div>
    </div>
  );
}
