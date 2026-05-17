# Splendor Assist

A browser-based assistant and AI lab for the board game **Splendor**. You enter the live state of a real-life game (your gems, the face-up cards, opponents' tableaus), and the app suggests a move. Under the hood it's a full TypeScript implementation of Splendor's rules with a stack of progressively stronger AI agents — handcrafted heuristics, alpha-beta search, and Monte Carlo Tree Search (plus an ISMCTS variant for the imperfect-information case).

It's also a teaching project. The [`diary/`](./diary) folder is a phase-by-phase notebook explaining the theory and design decisions behind every piece of the engine. Code in `src/` is the result; the diary is the thinking.

## What you can do with it

- **Assistant tab** — input the current state of a real game you're playing and get a recommended move with reasoning (which action, why, expected value).
- **Simulator tab** — same engine, but on an isolated localStorage slot so you can explore positions without clobbering your live session.
- **Card-entry tab** — utility for inputting cards from photos or play-by-play.
- **CLI tools** — run agent-vs-agent matches, tournaments, A/B comparisons, and run the coordinate-descent tuner.

## Quick start

```bash
npm install
npm run dev          # start the web app at http://localhost:5173
npm run build        # type-check + production build
npm test             # run the engine test suite (vitest)
```

CLI:

```bash
npm run play                                  # one self-play game (greedy P0 vs random P1+)
npm run match -- 100 42                       # 100-game tournament, seed 42
npm run compare -- 100 42 v9 search-d3 4      # A/B compare two agents in 4P
npm run firstmover                            # measure first-mover advantage
npm run tune -- 2 80 3 1                      # coordinate-descent tune (2P, 80 games/eval, 3 passes, seed 1)
```

## What's in the box

### Game engine (`src/game/`)

A pure, immutable TypeScript model of Splendor:

- `types.ts` — state, action, and card/noble types. Splendor is modeled as a tuple ⟨S, A, T, U, P⟩ (see [Phase 0 diary](./diary/phase-00-formalization.md) for the formalization).
- `legalActions.ts` / `apply.ts` — legal-action enumeration and a deterministic transition function, with eager refill of face-up slots from the (hidden-order) decks.
- `data/` — the canonical 90-card deck and noble set.
- `setup.ts` — seedable RNG, initial-state construction for 2/3/4 players.

### Agents (`src/game/agents.ts`, `agentFactory.ts`)

| Agent | What it is |
|---|---|
| `random` | uniform random legal action |
| `baseline`, `v2` | early handcrafted evaluators |
| `v3` | prestige + bonus_count + noble_proximity + opponent_threat |
| `v4`–`v8` | iterative additions: opponent noble proximity, endgame race mode, opponent 1-ply lookahead with noble chain, per-player-count normalization, self next-buy with competition discount |
| `v9` | per-player-count tuned weights (coordinate-descent over `v8`'s features) |
| `search-d2/d3/d4` | alpha-beta + max-N + move ordering + iterative deepening on `v3` |
| `iter-N` | iterative deepening, N-node budget |
| `mcts-N`, `mcts-Nms` | plain MCTS (iteration- or time-budgeted) with `v3` for rollouts and leaf eval |
| `ismcts-N`, `ismcts-Nms` | MCTS with per-iteration deck-shuffle determinization, for imperfect-information play |

All of these are constructable by name via `makeAgent(name, seed)` and can be plugged into the parallel tournament harness (`tournament.ts` + worker threads).

### Web UI (`src/AssistantApp.tsx`, `CardEntryApp.tsx`)

Single-page React app (Vite + React 19). Three tabs share the underlying engine:

- **Assistant** picks moves with MCTS using the `v9` evaluator inside rollouts. The current iteration budget is tuned for browser responsiveness, not strength.
- **Simulator** is the same UI but on a separate localStorage key, so you can sandbox positions.
- **Card entry** lets you build a card database from real games.

State is persisted to `localStorage` so you can close the tab mid-game and pick up later.

### Lab diary (`diary/`)

Phase-by-phase write-up of the project's reasoning. Each entry has the same structure: *Goal*, *Theory*, *Design decisions*, *Experiments / observations*, *Open questions*. The diary captures non-obvious choices, dead-ends, and measurement pitfalls that the code itself doesn't record.

- [Phase 0 — Formalize Splendor as a decision problem](./diary/phase-00-formalization.md)
- [Phase 1 — Handcrafted evaluator](./diary/phase-01-evaluator.md)
- [Phase 2 — Lookahead search](./diary/phase-02-search.md)
- [Phase 3 — MCTS](./diary/phase-03-mcts.md)
- [Phase 4 — Evaluator iteration & weight tuning](./diary/phase-04-tuning.md)

If you're using this as a reference for building your own game AI, read the diary in order — it's the part of the project that isn't trivially re-derivable from the source.

## Project layout

```
src/
  App.tsx                  # tab shell (Assistant / Simulator / Card entry)
  AssistantApp.tsx         # main assistant UI + state persistence
  CardEntryApp.tsx         # card database entry tool
  game/
    types.ts               # state / action / card types
    data/                  # 90 cards + nobles
    setup.ts               # initial state, seeded RNG
    legalActions.ts        # A(s)
    apply.ts               # T(s, a)
    evaluate.ts            # v1 … v9 + tunable evaluator
    search.ts              # alpha-beta + max-N + iterative deepening
    mcts.ts                # plain MCTS + ISMCTS determinization
    agents.ts              # Agent type + concrete agents
    agentFactory.ts        # name-based agent construction (for workers)
    tournament.ts          # parallel game runner (worker threads)
    *.test.ts              # vitest suites for every module
  cli/
    play.ts                # play / match / compare commands
    tune.ts                # coordinate-descent tuner
    measure-first-mover.ts # seat-bias measurement
diary/                     # design notebook (read this for the theory)
```

## Design notes

A few non-obvious choices worth flagging if you're poking around:

- **Eager refill.** When a face-up card leaves the board, the engine immediately draws a replacement from the (deterministic, seeded) deck. The alternative — a lazy "reveal" chance step — is cleaner for MCTS but more complex to thread through the UI. We took the simple path; ISMCTS handles the resulting hidden-information modeling at the search layer instead.
- **Information sets.** Reserved cards carry a `reservedFrom: 'faceUp' | 'deck'` tag so the engine knows what opponents can and can't see. The Assistant UI renders blind reserves face-down accordingly.
- **Engine-maintained caches.** `bonuses` and `prestige` on `PlayerState` are derivable from `purchased + nobles` but cached so evaluator leaves are O(1).
- **Worker-thread tournaments.** Agents are described by string (`{ name: 'v9' }` or `tunable:1.0,0.5,...`) so they can be reconstructed inside Node worker threads, which is how tournaments and the tuner achieve parallelism.

## Status

Built as a tutored learning project — the goal is to understand every layer of a game-AI stack rather than to ship the strongest possible Splendor bot. Phases 0–4 are complete. Phase 5 (learned components) is optional and not yet started. The "no compute constraint" plan at the end of [Phase 4](./diary/phase-04-tuning.md) lists the obvious next steps if anyone wants to push it further (Bayesian optimization over the weight space, MCTS with v9 inside at higher iteration counts, etc.).

## License

No license file is present, so this code is "all rights reserved" by default under copyright law. If you'd like to use it, open an issue.
