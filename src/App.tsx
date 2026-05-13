import { useEffect, useState } from 'react';
import AssistantApp from './AssistantApp';
import CardEntryApp from './CardEntryApp';
import './App.css';

type Mode = 'assistant' | 'simulator' | 'entry';
const STORAGE_KEY = 'splendor-shell-mode';
const SIM_STORAGE_KEY = 'splendor-simulator-state-v1';

const loadMode = (): Mode => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'assistant' || raw === 'simulator' || raw === 'entry') return raw;
  } catch {
    /* ignore */
  }
  return 'assistant';
};

export default function App() {
  const [mode, setMode] = useState<Mode>(loadMode);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  return (
    <div className="shell">
      <nav className="shell-tabs">
        <button
          type="button"
          className={`shell-tab ${mode === 'assistant' ? 'active' : ''}`}
          onClick={() => setMode('assistant')}
        >
          Assistant
        </button>
        <button
          type="button"
          className={`shell-tab ${mode === 'simulator' ? 'active' : ''}`}
          onClick={() => setMode('simulator')}
        >
          Simulator
        </button>
        <button
          type="button"
          className={`shell-tab ${mode === 'entry' ? 'active' : ''}`}
          onClick={() => setMode('entry')}
        >
          Card entry
        </button>
      </nav>
      <div className="shell-body">
        {mode === 'assistant' && <AssistantApp />}
        {mode === 'simulator' && (
          // Separate localStorage key so the sim runs on its own state and
          // doesn't clobber the user's real game session.
          <AssistantApp
            storageKey={SIM_STORAGE_KEY}
            mode="simulator"
            key="simulator"
          />
        )}
        {mode === 'entry' && <CardEntryApp />}
      </div>
    </div>
  );
}
