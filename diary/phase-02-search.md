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

## Experiment 8 — alpha-beta enables depth 3 (+44 pp over greedy)

**Hypothesis.** Alpha-beta pruning would cut a depth-3 search down
from "too slow to run" (~2 s/turn unpruned) to "interactive" (a few
hundred ms/turn). Splendor isn't strictly zero-sum, but the standard
treatment for alpha-beta in non-zero-sum games is *paranoid*: at the
opponent's turn, assume they pick whatever is worst for `me`. The
question is whether the deeper search this enables wins more than the
opponent-model error costs.

**Surprising result at depth 2.** Paranoid alpha-beta at depth 2
*loses* to greedy(v3) on average (3 seeds, 60 games):

|  Variant | Seed 7 | Seed 11 | Seed 23 | Net (60 games) |
|---|---|---|---|---|
| max-N depth 2     | +25 pp | +15 pp | +30 pp | **+23 pp** |
| alpha-beta depth 2 | +5 pp  | -40 pp | +20 pp | **-5 pp** |

The paranoid model assumes the opponent minimizes my evaluation; the
actual opponent (greedy with v3) maximizes their *own*. In v3 the
two diverge sharply — `opponent_threat` is mine, not theirs — so the
paranoid model expects defensive play and offensive plays the
opposite. At depth 2, planning against the wrong opponent costs more
than the half-pruning gives back.

**Depth 3 reverses the picture.** With one more ply of foresight,
alpha-beta wins decisively (3 seeds, 12 games each):

| Seed | search-d3 wins | greedy(v3) wins | Δ (pp) |
|---|---|---|---|
|  7 | 8 | 4 | **+33.3** |
| 11 | 10 | 2 | **+66.7** |
| 23 | 8 | 4 | **+33.3** |

Net **+44 pp** across 36 games. ~12 s/game, ~200 ms/turn — interactive.
Plain max-N at depth 3 is too slow to run head-to-head, so the
practical comparison is "alpha-beta d3 vs max-N d2" which is the same
+44 pp gap.

**Interpretation.** Pruning isn't a free lunch when the game isn't
strictly zero-sum, but at sufficient depth the foresight gain
dominates the model-error loss. The dispatcher in `searchBestAction`
encodes the resulting decision: 2-player matches use max-N for depth
≤ 2 and alpha-beta for depth ≥ 3. 3+ player matches always use max-N
(paranoid alpha-beta would imply coalition).

## What's left for Phase 2

- **Move ordering for alpha-beta.** Sort the root actions by 1-ply
  evaluator score before searching; better orderings produce more
  pruning. Likely cuts depth-3 turn time from ~200 ms to ~100 ms,
  which would put depth 4 in reach.
- **Iterative deepening with time budget.** Search depth 1, 2, 3,
  ... until the budget is spent. The previous iteration's best move
  is the obvious move-ordering signal for the next.
- **Re-run rejected Phase 1 features under search.** The pattern
  predicts engine_value and concentration may pay off once the
  evaluator is downstream of search rather than upstream. Worth
  retesting with `searchAgent(3)`.
- **Multi-player matches.** All experiments so far are 2-player.
  Verify search-d2 max-N behaves sensibly with 3-4 players.

## Phase 2 status

**Done:**
- `searchBestAction` + `searchAgent`.
- Multi-player max-N (`maxN` / `maxNSearch`).
- 2-player paranoid alpha-beta (`alphaBeta` / `alphaBetaSearch`).
- Dispatcher routing by player count and depth.
- 5 search tests (depth-1 ≡ greedy correctness anchor + depth-2/3
  plausibility for both 2-player and 4-player).
- Two regression matches in `tournament.test.ts`: max-N d2 ≥ greedy
  and alpha-beta d3 ≥ greedy.
- CLI `compare` mode supports `search-d2` and `search-d3` agents.

**Open:**
- Move ordering, iterative deepening, multi-player verification, and
  retesting the rejected Phase 1 features under search.
