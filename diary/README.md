# Splendor Assist — Lab Diary

A running notebook of the theory, design decisions, and experiments behind this project.

## How this diary works

Each phase has its own file. The structure of each entry:

1. **Goal** — what we're trying to learn / build in this phase.
2. **Theory** — the concepts from first principles. This is the "why."
3. **Design decisions** — the non-obvious choices we made and the alternatives we rejected.
4. **Experiments / observations** — what surprised us when we ran the code.
5. **Open questions** — what we deferred to a later phase.

The diary is the canonical record of the *thinking*. Code in `src/` is the canonical record of the *result*. Read both.

## Phases

- [Phase 0 — Formalize Splendor as a decision problem](phase-00-formalization.md) (complete)
- [Phase 1 — Handcrafted evaluator](phase-01-evaluator.md) (v3: prestige + bonus_count + noble_proximity + opponent_threat)
- [Phase 2 — Lookahead search](phase-02-search.md) (v3: alpha-beta + max-N + move ordering + iterative deepening)
- [Phase 3 — MCTS](phase-03-mcts.md) (v1: plain MCTS; ISMCTS with determinization queued for v2)
- [Phase 4 — Evaluator iteration & weight tuning](phase-04-tuning.md) (v4 → v9, coordinate-descent tuner, measurement pitfalls)
- Phase 5 — Learned components *(optional)*

## A note on pace

This project is deliberately tutored. We move slowly, articulate the theory before writing code, and capture every "why did we choose X over Y?" decision in writing. The point is not just to ship an assistant — it is to understand every layer of it.
