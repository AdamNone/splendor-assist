import { useEffect, useRef, useState } from 'react';
import './App.css';

type Color = 'white' | 'blue' | 'green' | 'red' | 'black';
type Tier = 1 | 2 | 3;

type DraftCard = {
  id: string;
  tier: Tier;
  bonus: Color;
  prestige: number;
  cost: Record<Color, number>;
};

const COLORS: Color[] = ['white', 'blue', 'green', 'red', 'black'];
const TIERS: Tier[] = [1, 2, 3];
const TIER_TOTALS: Record<Tier, number> = { 1: 40, 2: 30, 3: 20 };
const STORAGE_KEY = 'splendor-cards-draft-v1';

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

const emptyCost = (): Record<Color, number> => ({
  white: 0,
  blue: 0,
  green: 0,
  red: 0,
  black: 0,
});

const loadCards = (): DraftCard[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DraftCard[]) : [];
  } catch {
    return [];
  }
};

export default function App() {
  const [cards, setCards] = useState<DraftCard[]>(loadCards);
  const [tier, setTier] = useState<Tier>(1);
  const [bonus, setBonus] = useState<Color>('white');
  const [prestige, setPrestige] = useState<number>(0);
  const [cost, setCost] = useState<Record<Color, number>>(emptyCost());
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  }, [cards]);

  const tierCounts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0 };
  for (const c of cards) tierCounts[c.tier] += 1;
  const nextId = `T${tier}-${String(tierCounts[tier] + 1).padStart(3, '0')}`;

  const submit = () => {
    const newCard: DraftCard = {
      id: nextId,
      tier,
      bonus,
      prestige,
      cost: { ...cost },
    };
    setCards((prev) => [...prev, newCard]);
    setPrestige(0);
    setCost(emptyCost());
    submitRef.current?.blur();
  };

  const remove = (id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target;
      const inInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;

      if (e.key === 'Enter' && !inInput) {
        e.preventDefault();
        submit();
        return;
      }
      if (inInput) return;

      if (e.key === '1') setTier(1);
      else if (e.key === '2') setTier(2);
      else if (e.key === '3') setTier(3);

      const colorByKey = KEY_TO_COLOR[e.key.toLowerCase()];
      if (colorByKey !== undefined) setBonus(colorByKey);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(cards, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'splendor-cards.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalCost = COLORS.reduce((s, c) => s + cost[c], 0);

  return (
    <div className="app">
      <header>
        <h1>Splendor card entry</h1>
        <p className="sub">
          Type or click. <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> set tier,{' '}
          <kbd>W</kbd>/<kbd>B</kbd>/<kbd>G</kbd>/<kbd>R</kbd>/<kbd>K</kbd>{' '}
          set bonus, <kbd>Enter</kbd> submits.
        </p>
      </header>

      <section className="progress">
        {TIERS.map((t) => (
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
          </div>
        ))}
      </section>

      <section className="form">
        <div className="form-header">
          <h2>
            Next card: <code>{nextId}</code>
          </h2>
        </div>

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
          <label>Cost <span className="hint">(total: {totalCost})</span></label>
          <div className="cost-row">
            {COLORS.map((c) => (
              <div key={c} className="cost-cell">
                <div
                  className="swatch"
                  style={{ background: COLOR_HEX[c] }}
                  title={c}
                />
                <input
                  type="number"
                  min={0}
                  value={cost[c]}
                  onChange={(e) =>
                    setCost((prev) => ({
                      ...prev,
                      [c]: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                  onFocus={(e) => e.target.select()}
                  aria-label={`${c} cost`}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="actions">
          <button
            ref={submitRef}
            type="button"
            className="primary"
            onClick={submit}
          >
            Add card <kbd>Enter</kbd>
          </button>
          <button
            type="button"
            onClick={() => {
              setPrestige(0);
              setCost(emptyCost());
            }}
          >
            Reset numbers
          </button>
        </div>
      </section>

      <section className="list">
        <h2>Entered ({cards.length})</h2>
        {cards.length === 0 ? (
          <p className="empty">No cards yet. Submit one to get started.</p>
        ) : (
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
              {[...cards].reverse().map((c) => (
                <tr key={c.id}>
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
                  <td>
                    <button
                      type="button"
                      className="remove"
                      onClick={() => remove(c.id)}
                      aria-label={`Remove ${c.id}`}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="footer-actions">
        <button type="button" onClick={exportJson} disabled={cards.length === 0}>
          Export JSON
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (window.confirm('Delete all entered cards? This cannot be undone.')) {
              setCards([]);
            }
          }}
        >
          Clear all
        </button>
      </section>
    </div>
  );
}
