# Phase 2 — Lookahead search

**Status:** v1 complete (max-N at depth 2; alpha-beta queued for v2)
**Started:** 2026-05-10

## Goal

Phase 1 gave us an evaluator that scores a state from a player's
perspective. Greedy uses it 1-ply: try every legal action, evaluate the
resulting state, pick the highest. The pattern that emerged from
Phase 1's experiments was that greedy can only benefit from features
whose value differs across the agent's *own* legal actions — which is
restrictive. With lookahead search the picture changes: at depth 2 the
search literally simulates the opponent's response, so features that
only pay off "next turn" can finally contribute.

By the end of Phase 2 we want:

1. A correct, multi-player-friendly search algorithm (max-N).
2. The search composed with our existing v3 evaluator.
3. A measurable win over greedy(v3) in self-play.
4. (Stretch) alpha-beta pruning so depth 3 is reachable.

## Algorithm choice — max-N over minimax

**2-player Splendor is "almost zero-sum"** — your prestige doesn't
literally come at my expense, but reaching 15 first is the only thing
that matters, so practically maximizing my score is close to minimizing
yours. Strict zero-sum minimax is a poor fit, though, because Splendor
is *up to 4 players* and minimax doesn't generalize.

**Max-N** is the natural multi-player generalization: each node carries
a vector of utilities (one per player), and at each player's turn they
pick the action that maximizes *their own* component. The vector
returned at the leaf is whatever that choice produces.

Trade-offs we accepted:
- No pruning. Alpha-beta requires zero-sum and assumed adversaries;
  multi-player max-N has no clean pruning rule. Phase 2 v1 leaves
  this on the table.
- Deterministic reveals. Card refill is stochastic, but the search
  always draws the deterministic top of the deck. Phase 3 (ISMCTS)
  fixes this by sampling.

`searchBestAction(state, { depth })` lives in `src/game/search.ts`.
`searchAgent(depth, evalFn)` wraps it with the `Agent` interface.

**Sanity check:** at `depth=1`, max-N collapses to depth-1 greedy. The
`search.test.ts` suite asserts `searchAgent(1)(s) === greedyAgent()(s)`
on a deterministic state. That's the correctness anchor — anything
that breaks 1-ply equivalence is a bug in the search, not a feature.

## Experiment 7 — search depth-2 vs greedy(v3)

**Hypothesis.** Search at depth 2 simulates the opponent's best
response to my move. Greedy at depth 1 doesn't see the response at
all. So search should pick *defensively useful* moves greedy misses
— buying a card to deny it from the opponent, taking gems the
opponent needs, etc. Expected gain: large.

**Results (20 games head-to-head per seed):**

| Seed | search-d2 wins | greedy(v3) wins | Draws | Δ (pp) |
|---|---|---|---|---|
|  7 | 10 | 5 | 5 | **+25.0** |
| 11 | 9  | 6 | 5 | **+15.0** |
| 23 | 10 | 4 | 6 | **+30.0** |

Average **+23 pp** over 60 games. Bigger than any single Phase 1
feature gain.

**Cost.** Each turn at depth 2 takes ~75ms (≈75 candidate root
actions × 75 candidate replies × 0.5ms applyTurn each, before
arithmetic noise). A 50-turn game runs in ~3.8 seconds. The
tournament regression test stays well under its 120-second budget at
6 games.

**Re-enables earlier failures?** Not yet tested — Experiments 3 (concentration), 4 (engine_value), 5 (gem_pressure) were rejected because depth-1 greedy couldn't put their value to work. The hypothesis from Phase 1's lesson is that depth-2 search would re-enable some of them. *Future work*: re-run those features with `searchAgent(2)`.

## What's left for Phase 2

- **Alpha-beta pruning for the 2-player case.** Even though Splendor
  isn't strictly zero-sum, treating opponent_score - my_score as the
  utility lets us reuse standard alpha-beta. With pruning, depth 3
  becomes feasible (~1s/turn instead of ~2s without).
- **Iterative deepening with time budget.** "Spend up to N seconds on
  this decision" is a more user-friendly knob than "search to depth 2."
- **Re-run rejected Phase 1 features under search.** The pattern
  predicts engine_value and concentration may pay off once the
  evaluator is downstream of search rather than upstream.
- **Multi-player matches.** All experiments so far are 2-player.
  Verify search behaves sensibly with 3-4 players.

## Phase 2 status

**Done:**
- `searchBestAction` + `searchAgent` (max-N).
- Tests for correctness (depth-1 = greedy) and depth-2 plausibility.
- Regression match in `tournament.test.ts`.
- CLI `compare` mode upgraded to take agent names; supports
  `search-d2` and `search-d3` (latter slow).

**Next:**
- Alpha-beta for 2-player.
- Iterative deepening / time budget.
