import { useEffect, useState } from 'react';
import AssistantApp from './AssistantApp';
import CardEntryApp from './CardEntryApp';
import './App.css';

type Mode = 'assistant' | 'entry';
const STORAGE_KEY = 'splendor-shell-mode';

const loadMode = (): Mode => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'assistant' || raw === 'entry') return raw;
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
          className={`shell-tab ${mode === 'entry' ? 'active' : ''}`}
          onClick={() => setMode('entry')}
        >
          Card entry
        </button>
      </nav>
      <div className="shell-body">
        {mode === 'assistant' ? <AssistantApp /> : <CardEntryApp />}
      </div>
    </div>
  );
}
