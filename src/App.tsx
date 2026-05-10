import { useEffect, useRef, useState } from 'react';
import './App.css';

type Color = 'white' | 'blue' | 'green' | 'red' | 'black';
type Tier = 1 | 2 | 3;
type Mode = 'cards' | 'nobles';
type CardSort = 'newest' | 'tier-color';

type DraftCard = {
  id: string;
  tier: Tier;
  bonus: Color;
  prestige: number;
  cost: Record<Color, number>;
};

type DraftNoble = {
  id: string;
  prestige: number;
  requirement: Record<Color, number>;
};

type DraftData = {
  cards: DraftCard[];
  nobles: DraftNoble[];
  // Tool-internal: IDs the user has explicitly marked as verified against the
  // physical deck. Validation is suppressed for these. Not exported.
  verifiedIds: string[];
};

const COLORS: Color[] = ['white', 'blue', 'green', 'red', 'black'];
const TIERS: Tier[] = [1, 2, 3];
const TIER_TOTALS: Record<Tier, number> = { 1: 40, 2: 30, 3: 20 };
const NOBLES_TOTAL = 10;
const STORAGE_KEY = 'splendor-draft-v2';
const LEGACY_KEY = 'splendor-cards-draft-v1';

const COLOR_HEX: Record<Color, string> = {
  white: '#f4ead5',
  blue: '#2563eb',
  green: '#15803d',
  red: '#dc2626',
  black: '#1f2937',
};

const KEY_TO_COLOR: Record<string, Color> = {
  w: 'white',
  b: 'blue',
  g: 'green',
  r: 'red',
  k: 'black',
};

const emptyCount = (): Record<Color, number> => ({
  white: 0,
  blue: 0,
  green: 0,
  red: 0,
  black: 0,
});

const sumColors = (m: Record<Color, number>): number =>
  COLORS.reduce((s, c) => s + m[c], 0);

// Heuristic ranges drawn from standard Splendor. Used to flag entries that
// look unusual — never to block submission, since the user's physical deck
// is the ultimate authority.
type TierRange = {
  totalMin: number;
  totalMax: number;
  singleMax: number;
  prestigeMin: number;
  prestigeMax: number;
};

const TIER_RANGES: Record<Tier, TierRange> = {
  1: { totalMin: 3, totalMax: 7, singleMax: 4, prestigeMin: 0, prestigeMax: 1 },
  2: { totalMin: 5, totalMax: 10, singleMax: 6, prestigeMin: 1, prestigeMax: 3 },
  3: { totalMin: 9, totalMax: 16, singleMax: 7, prestigeMin: 3, prestigeMax: 5 },
};

const TIER_BONUS_TARGET: Record<Tier, number> = { 1: 8, 2: 6, 3: 4 };

const validateCard = (c: DraftCard): string[] => {
  const issues: string[] = [];
  const total = sumColors(c.cost);

  if (total === 0) {
    issues.push('Cost is empty');
    return issues;
  }

  if (c.cost[c.bonus] > 0) {
    issues.push(
      `Cost includes ${c.cost[c.bonus]} ${c.bonus} (own bonus color — uncommon, verify against the physical card)`,
    );
  }

  const r = TIER_RANGES[c.tier];

  if (total < r.totalMin || total > r.totalMax) {
    issues.push(
      `Total cost ${total} outside typical tier ${c.tier} range (${r.totalMin}–${r.totalMax})`,
    );
  }

  for (const col of COLORS) {
    if (c.cost[col] > r.singleMax) {
      issues.push(
        `${c.cost[col]} ${col} exceeds typical tier ${c.tier} single-color max (${r.singleMax})`,
      );
    }
  }

  if (c.prestige < r.prestigeMin || c.prestige > r.prestigeMax) {
    issues.push(
      `Prestige ${c.prestige} outside typical tier ${c.tier} range (${r.prestigeMin}–${r.prestigeMax})`,
    );
  }

  return issues;
};

const validateNoble = (n: DraftNoble): string[] => {
  const issues: string[] = [];
  const total = sumColors(n.requirement);

  if (total === 0) {
    issues.push('Requirement is empty');
    return issues;
  }

  if (total !== 8 && total !== 9) {
    issues.push(
      `Total requirement ${total} unusual (expected 8 for 4+4 nobles, 9 for 3+3+3 nobles)`,
    );
  }

  for (const col of COLORS) {
    const v = n.requirement[col];
    if (v !== 0 && v !== 3 && v !== 4) {
      issues.push(
        `${v} ${col} unusual (each requirement value should be 0, 3, or 4)`,
      );
    }
  }

  const usedColors = COLORS.filter((c) => n.requirement[c] > 0).length;
  const fourCount = COLORS.filter((c) => n.requirement[c] === 4).length;
  const threeCount = COLORS.filter((c) => n.requirement[c] === 3).length;

  if (total === 8 && (usedColors !== 2 || fourCount !== 2)) {
    issues.push('A 4+4 noble should use exactly two colors at 4 each');
  }
  if (total === 9 && (usedColors !== 3 || threeCount !== 3)) {
    issues.push('A 3+3+3 noble should use exactly three colors at 3 each');
  }

  if (n.prestige !== 3) {
    issues.push(`Prestige ${n.prestige} differs from the standard 3`);
  }

  return issues;
};

const validateGlobal = (data: DraftData): string[] => {
  const issues: string[] = [];

  for (const t of TIERS) {
    const inTier = data.cards.filter((c) => c.tier === t);
    if (inTier.length > TIER_TOTALS[t]) {
      issues.push(
        `Tier ${t}: ${inTier.length} cards (more than the standard ${TIER_TOTALS[t]})`,
      );
    }
    // Only check bonus distribution once a tier is fully populated; partial
    // entries trip false positives constantly.
    if (inTier.length === TIER_TOTALS[t]) {
      const counts = emptyCount();
      for (const c of inTier) counts[c.bonus] += 1;
      const exp = TIER_BONUS_TARGET[t];
      for (const col of COLORS) {
        if (counts[col] !== exp) {
          issues.push(
            `Tier ${t}: ${counts[col]} ${col}-bonus cards (expected ${exp})`,
          );
        }
      }
    }
  }

  if (data.nobles.length > NOBLES_TOTAL) {
    issues.push(
      `${data.nobles.length} nobles entered (more than the standard ${NOBLES_TOTAL})`,
    );
  }

  return issues;
};

const idTail = (id: string): number => {
  const parts = id.split('-');
  const last = parts[parts.length - 1];
  if (last === undefined) return 0;
  const n = parseInt(last, 10);
  return Number.isFinite(n) ? n : 0;
};

const loadData = (): DraftData => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          cards: Array.isArray(parsed.cards) ? (parsed.cards as DraftCard[]) : [],
          nobles: Array.isArray(parsed.nobles) ? (parsed.nobles as DraftNoble[]) : [],
          verifiedIds: Array.isArray(parsed.verifiedIds)
            ? (parsed.verifiedIds as string[])
            : [],
        };
      }
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy !== null) {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed)) {
        return { cards: parsed as DraftCard[], nobles: [], verifiedIds: [] };
      }
    }
  } catch {
    /* fall through */
  }
  return { cards: [], nobles: [], verifiedIds: [] };
};

export default function App() {
  const [data, setData] = useState<DraftData>(loadData);
  const [mode, setMode] = useState<Mode>('cards');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showOnlyFlagged, setShowOnlyFlagged] = useState<boolean>(false);
  const [cardSort, setCardSort] = useState<CardSort>('newest');

  // Card form state
  const [tier, setTier] = useState<Tier>(1);
  const [bonus, setBonus] = useState<Color>('white');
  const [prestige, setPrestige] = useState<number>(0);
  const [cost, setCost] = useState<Record<Color, number>>(emptyCount());

  // Noble form state
  const [noblePrestige, setNoblePrestige] = useState<number>(3);
  const [requirement, setRequirement] = useState<Record<Color, number>>(emptyCount());

  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  const tierCounts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0 };
  for (const c of data.cards) tierCounts[c.tier] += 1;

  const nextCardId = (() => {
    let max = 0;
    for (const c of data.cards) {
      if (c.tier === tier) max = Math.max(max, idTail(c.id));
    }
    return `T${tier}-${String(max + 1).padStart(3, '0')}`;
  })();

  const nextNobleId = (() => {
    let max = 0;
    for (const n of data.nobles) max = Math.max(max, idTail(n.id));
    return `N-${String(max + 1).padStart(3, '0')}`;
  })();

  const resetCardForm = () => {
    setPrestige(0);
    setCost(emptyCount());
  };

  const resetNobleForm = () => {
    setNoblePrestige(3);
    setRequirement(emptyCount());
  };

  const cancelEdit = () => {
    if (editingId === null) return;
    setEditingId(null);
    if (mode === 'cards') resetCardForm();
    else resetNobleForm();
  };

  const submitCard = () => {
    if (editingId !== null) {
      const targetId = editingId;
      setData((prev) => ({
        ...prev,
        cards: prev.cards.map((c) =>
          c.id === targetId ? { ...c, tier, bonus, prestige, cost: { ...cost } } : c,
        ),
        // Editing clears verified — the new state must be re-validated.
        verifiedIds: prev.verifiedIds.filter((id) => id !== targetId),
      }));
      setEditingId(null);
    } else {
      const newCard: DraftCard = {
        id: nextCardId,
        tier,
        bonus,
        prestige,
        cost: { ...cost },
      };
      setData((prev) => ({ ...prev, cards: [...prev.cards, newCard] }));
    }
    resetCardForm();
    submitRef.current?.blur();
  };

  const submitNoble = () => {
    if (editingId !== null) {
      const targetId = editingId;
      setData((prev) => ({
        ...prev,
        nobles: prev.nobles.map((n) =>
          n.id === targetId
            ? { ...n, prestige: noblePrestige, requirement: { ...requirement } }
            : n,
        ),
        verifiedIds: prev.verifiedIds.filter((id) => id !== targetId),
      }));
      setEditingId(null);
    } else {
      const newNoble: DraftNoble = {
        id: nextNobleId,
        prestige: noblePrestige,
        requirement: { ...requirement },
      };
      setData((prev) => ({ ...prev, nobles: [...prev.nobles, newNoble] }));
    }
    resetNobleForm();
    submitRef.current?.blur();
  };

  const markVerified = (id: string) => {
    setData((prev) =>
      prev.verifiedIds.includes(id)
        ? prev
        : { ...prev, verifiedIds: [...prev.verifiedIds, id] },
    );
  };

  const submit = () => {
    if (mode === 'cards') submitCard();
    else submitNoble();
  };

  const startEditCard = (c: DraftCard) => {
    setMode('cards');
    setEditingId(c.id);
    setTier(c.tier);
    setBonus(c.bonus);
    setPrestige(c.prestige);
    setCost({ ...c.cost });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const startEditNoble = (n: DraftNoble) => {
    setMode('nobles');
    setEditingId(n.id);
    setNoblePrestige(n.prestige);
    setRequirement({ ...n.requirement });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const removeCard = (id: string) => {
    if (editingId === id) cancelEdit();
    setData((prev) => ({
      ...prev,
      cards: prev.cards.filter((c) => c.id !== id),
      verifiedIds: prev.verifiedIds.filter((vid) => vid !== id),
    }));
  };

  const removeNoble = (id: string) => {
    if (editingId === id) cancelEdit();
    setData((prev) => ({
      ...prev,
      nobles: prev.nobles.filter((n) => n.id !== id),
      verifiedIds: prev.verifiedIds.filter((vid) => vid !== id),
    }));
  };

  const switchMode = (next: Mode) => {
    cancelEdit();
    setMode(next);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target;
      const inInput =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (e.key === 'Escape' && editingId !== null) {
        e.preventDefault();
        cancelEdit();
        return;
      }
      if (e.key === 'Enter' && !inInput) {
        e.preventDefault();
        submit();
        return;
      }
      if (inInput) return;

      if (mode === 'cards') {
        if (e.key === '1') setTier(1);
        else if (e.key === '2') setTier(2);
        else if (e.key === '3') setTier(3);
        const colorByKey = KEY_TO_COLOR[e.key.toLowerCase()];
        if (colorByKey !== undefined) setBonus(colorByKey);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const exportJson = (kind: 'cards' | 'nobles') => {
    const items = kind === 'cards' ? data.cards : data.nobles;
    const blob = new Blob([JSON.stringify(items, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `splendor-${kind}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const headingId = editingId !== null ? editingId : mode === 'cards' ? nextCardId : nextNobleId;
  const headingLabel = editingId !== null ? 'Editing' : 'Next';

  // Validation — recomputed every render. Cheap; data is small.
  // Verified entries have their warnings suppressed.
  const verified = new Set(data.verifiedIds);
  const cardIssues: Record<string, string[]> = {};
  for (const c of data.cards) {
    cardIssues[c.id] = verified.has(c.id) ? [] : validateCard(c);
  }
  const nobleIssues: Record<string, string[]> = {};
  for (const n of data.nobles) {
    nobleIssues[n.id] = verified.has(n.id) ? [] : validateNoble(n);
  }
  const globalIssues = validateGlobal(data);
  const cardsFlagged = Object.values(cardIssues).filter((arr) => arr.length > 0).length;
  const noblesFlagged = Object.values(nobleIssues).filter((arr) => arr.length > 0).length;

  // Live form draft validation — suppressed when nothing has been entered yet.
  const draftCard: DraftCard = {
    id: editingId ?? 'draft',
    tier,
    bonus,
    prestige,
    cost,
  };
  const draftNoble: DraftNoble = {
    id: editingId ?? 'draft',
    prestige: noblePrestige,
    requirement,
  };
  const formStarted =
    mode === 'cards'
      ? sumColors(cost) > 0 || prestige > 0
      : sumColors(requirement) > 0 || noblePrestige !== 3;
  const draftIssues = !formStarted
    ? []
    : mode === 'cards'
      ? validateCard(draftCard)
      : validateNoble(draftNoble);

  const renderColorRow = (
    value: Record<Color, number>,
    onChange: (next: Record<Color, number>) => void,
    ariaPrefix: string,
  ) => (
    <div className="cost-row">
      {COLORS.map((c) => (
        <div key={c} className="cost-cell">
          <div className="swatch" style={{ background: COLOR_HEX[c] }} title={c} />
          <input
            type="number"
            min={0}
            value={value[c]}
            onChange={(e) =>
              onChange({ ...value, [c]: Math.max(0, Number(e.target.value) || 0) })
            }
            onFocus={(e) => e.target.select()}
            aria-label={`${ariaPrefix} ${c}`}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div className="app">
      <header>
        <h1>Splendor data entry</h1>
        <p className="sub">
          Type or click. <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> tier (cards),{' '}
          <kbd>W</kbd>/<kbd>B</kbd>/<kbd>G</kbd>/<kbd>R</kbd>/<kbd>K</kbd> bonus,{' '}
          <kbd>Enter</kbd> submit, <kbd>Esc</kbd> cancel edit.
        </p>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={`tab ${mode === 'cards' ? 'active' : ''}`}
          onClick={() => switchMode('cards')}
        >
          Cards <span className="tab-count">{data.cards.length}</span>
          {cardsFlagged > 0 && (
            <span className="tab-warn" aria-label={`${cardsFlagged} flagged`}>
              ⚠ {cardsFlagged}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`tab ${mode === 'nobles' ? 'active' : ''}`}
          onClick={() => switchMode('nobles')}
        >
          Nobles <span className="tab-count">{data.nobles.length}</span>
          {noblesFlagged > 0 && (
            <span className="tab-warn" aria-label={`${noblesFlagged} flagged`}>
              ⚠ {noblesFlagged}
            </span>
          )}
        </button>
      </nav>

      {globalIssues.length > 0 && (
        <section className="global-issues">
          <div className="issues-title">⚠ Global checks</div>
          <ul>
            {globalIssues.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="progress">
        {mode === 'cards' ? (
          TIERS.map((t) => {
            const expected = TIER_BONUS_TARGET[t];
            const bonusCounts: Record<Color, number> = emptyCount();
            for (const c of data.cards) {
              if (c.tier === t) bonusCounts[c.bonus] += 1;
            }
            return (
              <div key={t} className="progress-row">
                <span className="progress-label">Tier {t}</span>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${Math.min(100, (tierCounts[t] / TIER_TOTALS[t]) * 100)}%`,
                    }}
                  />
                </div>
                <span className="progress-count">
                  {tierCounts[t]} / {TIER_TOTALS[t]}
                </span>
                <div className="bonus-breakdown" aria-label={`Tier ${t} bonus distribution`}>
                  {COLORS.map((col) => {
                    const n = bonusCounts[col];
                    const status =
                      n > expected
                        ? 'over'
                        : n === expected
                          ? 'full'
                          : n === 0
                            ? 'empty'
                            : 'partial';
                    return (
                      <span
                        key={col}
                        className={`bonus-chip ${status}`}
                        style={{
                          background: COLOR_HEX[col],
                          color: col === 'white' ? '#1f2937' : '#fff',
                        }}
                        title={`${n} of ${expected} ${col}-bonus cards in tier ${t}`}
                      >
                        {n}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })
        ) : (
          <div className="progress-row">
            <span className="progress-label">Nobles</span>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.min(100, (data.nobles.length / NOBLES_TOTAL) * 100)}%`,
                }}
              />
            </div>
            <span className="progress-count">
              {data.nobles.length} / {NOBLES_TOTAL}
            </span>
          </div>
        )}
      </section>

      <section className={`form ${editingId !== null ? 'editing' : ''}`}>
        <div className="form-header">
          <h2>
            {headingLabel}: <code>{headingId}</code>
          </h2>
          {editingId !== null && (
            <button type="button" className="link" onClick={cancelEdit}>
              Cancel <kbd>Esc</kbd>
            </button>
          )}
        </div>

        {mode === 'cards' ? (
          <>
            <div className="field">
              <label>Tier</label>
              <div className="buttons">
                {TIERS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`pill ${tier === t ? 'active' : ''}`}
                    onClick={() => setTier(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Bonus</label>
              <div className="buttons">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`color-btn ${bonus === c ? 'active' : ''}`}
                    style={{
                      background: COLOR_HEX[c],
                      color: c === 'white' ? '#1f2937' : '#fff',
                    }}
                    onClick={() => setBonus(c)}
                    aria-label={`Bonus ${c}`}
                  >
                    {c.charAt(0).toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label htmlFor="prestige">Prestige</label>
              <input
                id="prestige"
                type="number"
                min={0}
                max={5}
                value={prestige}
                onChange={(e) =>
                  setPrestige(Math.max(0, Number(e.target.value) || 0))
                }
                onFocus={(e) => e.target.select()}
              />
            </div>

            <div className="field">
              <label>
                Cost <span className="hint">(total: {sumColors(cost)})</span>
              </label>
              {renderColorRow(cost, setCost, 'cost')}
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="noble-prestige">Prestige</label>
              <input
                id="noble-prestige"
                type="number"
                min={0}
                max={5}
                value={noblePrestige}
                onChange={(e) =>
                  setNoblePrestige(Math.max(0, Number(e.target.value) || 0))
                }
                onFocus={(e) => e.target.select()}
              />
            </div>
            <div className="field">
              <label>
                Requirement{' '}
                <span className="hint">
                  (total: {sumColors(requirement)} · expect 8 or 9)
                </span>
              </label>
              {renderColorRow(requirement, setRequirement, 'requirement')}
            </div>
          </>
        )}

        <div className="actions">
          <button
            ref={submitRef}
            type="button"
            className="primary"
            onClick={submit}
          >
            {editingId !== null ? 'Save changes' : 'Add'} <kbd>Enter</kbd>
          </button>
          <button
            type="button"
            onClick={() =>
              mode === 'cards' ? resetCardForm() : resetNobleForm()
            }
          >
            Reset numbers
          </button>
        </div>

        {draftIssues.length > 0 && (
          <div className="form-issues">
            <div className="issues-title">⚠ Heuristic checks</div>
            <ul>
              {draftIssues.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="list">
        <div className="list-header">
          <h2>
            {mode === 'cards'
              ? `Cards (${data.cards.length})`
              : `Nobles (${data.nobles.length})`}
          </h2>
          <div className="list-controls">
            {mode === 'cards' && data.cards.length > 0 && (
              <label className="sort-control">
                Sort
                <select
                  value={cardSort}
                  onChange={(e) => setCardSort(e.target.value as CardSort)}
                >
                  <option value="newest">Newest first</option>
                  <option value="tier-color">Tier, then color</option>
                </select>
              </label>
            )}
            {((mode === 'cards' && cardsFlagged > 0) ||
              (mode === 'nobles' && noblesFlagged > 0)) && (
              <label className="filter-toggle">
                <input
                  type="checkbox"
                  checked={showOnlyFlagged}
                  onChange={(e) => setShowOnlyFlagged(e.target.checked)}
                />
                Show only flagged
              </label>
            )}
          </div>
        </div>
        {mode === 'cards' ? (
          data.cards.length === 0 ? (
            <p className="empty">No cards yet. Submit one to get started.</p>
          ) : (
            (() => {
              const sorted = [...data.cards];
              if (cardSort === 'newest') {
                sorted.reverse();
              } else {
                sorted.sort(
                  (a, b) =>
                    a.tier - b.tier ||
                    COLORS.indexOf(a.bonus) - COLORS.indexOf(b.bonus) ||
                    idTail(a.id) - idTail(b.id),
                );
              }
              const visible = sorted.filter((c) =>
                showOnlyFlagged ? (cardIssues[c.id]?.length ?? 0) > 0 : true,
              );
              if (visible.length === 0) {
                return <p className="empty">No flagged cards. Toggle the filter off to see all.</p>;
              }
              return (
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Bonus</th>
                      <th>Prestige</th>
                      <th>Cost</th>
                      <th aria-label="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.flatMap((c) => {
                      const issues = cardIssues[c.id] ?? [];
                      const rowClasses = [
                        editingId === c.id ? 'editing-row' : '',
                        issues.length > 0 ? 'flagged-row' : '',
                      ]
                        .filter(Boolean)
                        .join(' ');
                      const rows = [
                        <tr key={c.id} className={rowClasses}>
                          <td>
                            <code>{c.id}</code>
                          </td>
                          <td>
                            <span
                              className="swatch inline"
                              style={{ background: COLOR_HEX[c.bonus] }}
                              title={c.bonus}
                            />
                          </td>
                          <td>{c.prestige}</td>
                          <td className="cost-summary">
                            {COLORS.filter((col) => c.cost[col] > 0)
                              .map((col) => `${c.cost[col]} ${col}`)
                              .join(', ') || '—'}
                          </td>
                          <td className="row-actions">
                            <button
                              type="button"
                              className="row-btn"
                              onClick={() => startEditCard(c)}
                              aria-label={`Edit ${c.id}`}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="remove"
                              onClick={() => removeCard(c.id)}
                              aria-label={`Remove ${c.id}`}
                            >
                              ×
                            </button>
                          </td>
                        </tr>,
                      ];
                      if (issues.length > 0) {
                        const hasSelfBonus = c.cost[c.bonus] > 0;
                        rows.push(
                          <tr key={`${c.id}-issues`} className="issues-row">
                            <td colSpan={5}>
                              {issues.map((s, i) => (
                                <div key={i}>⚠ {s}</div>
                              ))}
                              <div className="issues-actions">
                                {hasSelfBonus && (
                                  <button
                                    type="button"
                                    className="suggest-fix"
                                    onClick={() =>
                                      startEditCard({
                                        ...c,
                                        cost: { ...c.cost, [c.bonus]: 0 },
                                      })
                                    }
                                    title={`Open ${c.id} in edit mode with the ${c.bonus} column pre-zeroed so you can re-enter from the card`}
                                  >
                                    Quick fix: clear {c.bonus} column &amp; edit
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="mark-verified"
                                  onClick={() => markVerified(c.id)}
                                  title="I have checked this against the physical card. Suppress these warnings for this entry."
                                >
                                  ✓ Mark verified
                                </button>
                              </div>
                            </td>
                          </tr>,
                        );
                      }
                      return rows;
                    })}
                  </tbody>
                </table>
              );
            })()
          )
        ) : data.nobles.length === 0 ? (
          <p className="empty">No nobles yet. Submit one to get started.</p>
        ) : (
          (() => {
            const visible = [...data.nobles]
              .reverse()
              .filter((n) =>
                showOnlyFlagged ? (nobleIssues[n.id]?.length ?? 0) > 0 : true,
              );
            if (visible.length === 0) {
              return <p className="empty">No flagged nobles. Toggle the filter off to see all.</p>;
            }
            return (
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Prestige</th>
                    <th>Requirement</th>
                    <th aria-label="actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.flatMap((n) => {
                    const issues = nobleIssues[n.id] ?? [];
                    const rowClasses = [
                      editingId === n.id ? 'editing-row' : '',
                      issues.length > 0 ? 'flagged-row' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    const rows = [
                      <tr key={n.id} className={rowClasses}>
                        <td>
                          <code>{n.id}</code>
                        </td>
                        <td>{n.prestige}</td>
                        <td className="cost-summary">
                          {COLORS.filter((col) => n.requirement[col] > 0)
                            .map((col) => `${n.requirement[col]} ${col}`)
                            .join(', ') || '—'}
                        </td>
                        <td className="row-actions">
                          <button
                            type="button"
                            className="row-btn"
                            onClick={() => startEditNoble(n)}
                            aria-label={`Edit ${n.id}`}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="remove"
                            onClick={() => removeNoble(n.id)}
                            aria-label={`Remove ${n.id}`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>,
                    ];
                    if (issues.length > 0) {
                      rows.push(
                        <tr key={`${n.id}-issues`} className="issues-row">
                          <td colSpan={4}>
                            {issues.map((s, i) => (
                              <div key={i}>⚠ {s}</div>
                            ))}
                            <div className="issues-actions">
                              <button
                                type="button"
                                className="mark-verified"
                                onClick={() => markVerified(n.id)}
                                title="I have checked this against the physical card. Suppress these warnings for this entry."
                              >
                                ✓ Mark verified
                              </button>
                            </div>
                          </td>
                        </tr>,
                      );
                    }
                    return rows;
                  })}
                </tbody>
              </table>
            );
          })()
        )}
      </section>

      <section className="footer-actions">
        <div className="export-group">
          <button
            type="button"
            onClick={() => exportJson('cards')}
            disabled={data.cards.length === 0}
          >
            Export cards
          </button>
          <button
            type="button"
            onClick={() => exportJson('nobles')}
            disabled={data.nobles.length === 0}
          >
            Export nobles
          </button>
        </div>
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (
              window.confirm(
                'Delete all entered cards AND nobles? This cannot be undone.',
              )
            ) {
              setData({ cards: [], nobles: [], verifiedIds: [] });
              cancelEdit();
            }
          }}
        >
          Clear all
        </button>
      </section>
    </div>
  );
}
