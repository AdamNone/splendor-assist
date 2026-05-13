import { useEffect, useMemo, useState } from 'react';
// useMemo is used inside CardPickerModal below.
import { mctsBestActionWithStats } from './game/mcts';
import type { MctsCandidate } from './game/mcts';
import { evaluateV3 } from './game/evaluate';
import { ALL_CARDS, ALL_NOBLES } from './game/data';
import { narrate } from './game/narrate';
import { seededRng } from './game/setup';
import { COLORS, GEM_COLORS, TIERS } from './game/types';
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
  gemSupply: GemPool;
  faceUp: FaceUpGrid;
  nobles: Noble[];
  players: PlayerForm[];
};

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
    gemSupply: { ...GEM_SUPPLY_DEFAULT[2] },
    faceUp: emptyFaceUp(),
    nobles: [],
    players: [emptyPlayer(), emptyPlayer()],
  };
};

type Alternative = {
  summary: string;
  visits: number;
  meanReward: number;
};

type Recommendation = {
  summary: string;
  winRates: number[];
  currentPlayer: number;
  rootVisits: number;
  alternatives: Alternative[];
  thinkingMs: number;
};

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

export default function AssistantApp() {
  const [s, setS] = useState<AssistantState>(initialState);
  const [thinking, setThinking] = useState(false);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

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
        gemSupply: { ...GEM_SUPPLY_DEFAULT[n] },
        players,
      };
    });
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

  const onRecommend = async () => {
    const issues = validate();
    setErrors(issues);
    setThinking(true);
    setRecommendation(null);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the spinner render
    try {
      const state = buildGameState(s);
      const start = Date.now();
      const stats = mctsBestActionWithStats(state, {
        iterations: 500,
        evalFn: evaluateV3,
        rng: seededRng(Date.now() & 0xffff_ffff),
      });
      const summary = describeAction(state, stats.bestAction);
      const alternatives: Alternative[] = stats.candidates
        .slice(1, 5)
        .map((c: MctsCandidate) => ({
          summary: describeAction(state, c.action),
          visits: c.visits,
          meanReward: c.meanReward,
        }));
      setRecommendation({
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
              Enter the current game state and press <kbd>Recommend</kbd> to get
              an MCTS move suggestion. State persists to localStorage between
              sessions.
            </p>
          </div>
          <button type="button" className="new-game-btn" onClick={resetGame}>
            New game
          </button>
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
                P{i}
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
              <input
                type="number"
                min={0}
                value={s.gemSupply[c]}
                onChange={(e) => setSupplyGem(c, Number(e.target.value) || 0)}
                onFocus={(e) => e.target.select()}
                aria-label={`supply ${c}`}
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
            isCurrent={idx === s.currentPlayer}
            player={p}
            onBonus={(c, v) => setPlayerBonus(idx, c, v)}
            onGem={(c, v) => setPlayerGem(idx, c, v)}
            onPrestige={(v) => setPlayerPrestige(idx, v)}
          />
        ))}
      </section>

      <section className="card recommend">
        <button
          type="button"
          className="recommend-btn"
          onClick={onRecommend}
          disabled={thinking}
        >
          {thinking ? 'Thinking…' : 'Recommend move'}
        </button>
        {errors.length > 0 && (
          <div className="issues">
            {errors.map((e, i) => (
              <div key={i}>⚠ {e}</div>
            ))}
          </div>
        )}
        {recommendation && (
          <div className="recommendation">
            <div className="rec-line">
              <strong>Recommended:</strong> {recommendation.summary}
            </div>

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
                      P{i}{isMe ? ' (to move)' : ''}
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
                <div className="alt-title">Next-best options</div>
                <ul>
                  {recommendation.alternatives.map((a, i) => (
                    <li key={i}>
                      <span className="alt-summary">{a.summary}</span>
                      <span className="alt-meta">
                        {(a.meanReward * 100).toFixed(0)}% · {a.visits} visits
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rec-meta">
              MCTS · {recommendation.rootVisits} iter · {recommendation.thinkingMs} ms
            </div>
          </div>
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

function PlayerPanel({
  idx,
  isCurrent,
  player,
  onBonus,
  onGem,
  onPrestige,
}: {
  idx: number;
  isCurrent: boolean;
  player: PlayerForm;
  onBonus: (c: Color, v: number) => void;
  onGem: (c: GemColor, v: number) => void;
  onPrestige: (v: number) => void;
}) {
  return (
    <div className={`player-panel ${isCurrent ? 'current' : ''}`}>
      <div className="player-header">
        <strong>P{idx}</strong>
        {isCurrent && <span className="badge">to move</span>}
      </div>
      <div className="player-row">
        <span className="player-label">Bonuses</span>
        <div className="gem-row">
          {COLORS.map((c) => (
            <div key={c} className="gem-cell">
              <div className="swatch" style={{ background: COLOR_HEX[c] }} />
              <input
                type="number"
                min={0}
                value={player.bonuses[c]}
                onChange={(e) => onBonus(c, Number(e.target.value) || 0)}
                onFocus={(e) => e.target.select()}
                aria-label={`P${idx} bonus ${c}`}
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
              <input
                type="number"
                min={0}
                value={player.gems[c]}
                onChange={(e) => onGem(c, Number(e.target.value) || 0)}
                onFocus={(e) => e.target.select()}
                aria-label={`P${idx} gem ${c}`}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="player-row">
        <span className="player-label">Prestige</span>
        <input
          type="number"
          min={0}
          value={player.prestige}
          onChange={(e) => onPrestige(Number(e.target.value) || 0)}
          onFocus={(e) => e.target.select()}
          aria-label={`P${idx} prestige`}
          className="prestige-input"
        />
      </div>
    </div>
  );
}
