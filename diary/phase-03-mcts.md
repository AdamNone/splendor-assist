# Phase 3 — MCTS

**Status:** v1 complete (plain MCTS with UCB1 and depth-capped rollouts).
ISMCTS with determinization is queued for v2.
**Started:** 2026-05-13

## Goal

Phase 2's alpha-beta search resolves card reveals deterministically (top of
deck) and assumes a paranoid opponent (minimizes our eval). Both
assumptions are simplifications: Splendor's deck order is genuinely
hidden, and the opponent's actual incentive is to maximize their own
score, not to minimize ours. Phase 3 introduces Monte Carlo Tree
Search to address both:

1. **MCTS naturally handles stochasticity** by averaging over many
   sampled trajectories. Random rollouts are a faithful "things might
   happen" model rather than a hardcoded "always top of deck."
2. **MCTS with random rollouts is a softer opponent model** than
   paranoid alpha-beta. A random opponent isn't *trying* to hurt us;
   the rollout reward distribution captures "play continues, who tends
   to come out ahead?" — which empirically tracks how the actual
   greedy/heuristic opponents play far better than paranoid does.
3. **Determinization (v2)** will sample plausible deck orders and
   hidden reserves consistent with the active player's information set,
   turning Splendor's hidden info into honest probability over
   possibilities rather than a deterministic best-case fiction.

By the end of Phase 3 v1 we want a working MCTS that's at least
*competitive* with `search-d3`; the bonus would be that it strictly
beats it given comparable compute.

## Algorithm — UCB1 + depth-capped rollouts + multi-player rewards

`mctsBestAction(rootState, options)` in `src/game/mcts.ts`. Standard
four-step loop per iteration:

1. **Selection.** From the root, walk down the tree by repeatedly
   picking the child that maximizes the UCB1 score *from the current
   node's player's perspective*:

   ```
   UCB1(child) = totalReward[parentPlayer] / visits
               + c * sqrt(ln(parentVisits) / visits)
   ```

   `c = sqrt(2)` is the textbook constant. Untried actions get
   priority (score = +∞).

2. **Expansion.** When we reach a node that still has untried actions,
   pick one, apply it, create a new child, and stop the descent there.

3. **Simulation (rollout).** From the new child's state, play random
   legal actions for at most `rolloutDepth` turns (default 20). If a
   terminal state is reached, the reward is `1` for the winner and `0`
   for everyone else. If we hit the rollout cap, the v3 evaluator
   scores the leaf state from each player's perspective; those scores
   are squashed through `sigmoid(x/5)` so they live in `[0, 1]` and can
   be averaged with terminal outcomes.

4. **Backpropagation.** Walk back up from the new child to the root,
   incrementing each node's `visits` and adding the rollout's reward
   vector to its `totalReward` vector.

Reward is tracked **as a vector indexed by player**, so the same tree
generalizes 2→3→4 players naturally. UCB1's exploit term reads
`totalReward[parentPlayer]` so each player at their own turn maximizes
their own utility.

The final action returned is the **most-visited** root child, not the
highest-mean one — visit count is a more stable signal when budgets
are limited and a small handful of visits can produce wildly
fluctuating means.

### Why depth-capped rollouts and not full random play

A full random rollout in Splendor runs ~50 turns × ~0.5 ms `applyTurn`
each = ~25 ms per rollout. Many iterations would take many seconds per
move, and worse: pure random play is *very* far from optimal Splendor
strategy, so the rewards it produces are mostly noise about the
position. Depth-20 capped rollouts with the v3 evaluator at the leaf
keep iteration cost down (~2–5 ms each) and produce rewards that
reflect the position's *near-term* outlook rather than pure noise.

## Experiment 11 — MCTS vs search-d3

**Setup.** `mctsAgent` is used with both iteration-count budgets
(`mcts-200`, `mcts-500`, etc.) and time budgets (`mcts-500ms`,
`mcts-1s`, `mcts-3s`). search-d3 averages ~120 ms/turn so a 500 ms
budget for MCTS is ~4× more compute per move; 1 s is ~8×.

**Results (8 games per cell, seed in column header):**

| Match                       | Seed 7  | Seed 100 | Net (16 games)      |
|---|---|---|---|
| mcts-1s vs search-d3        | +62.5 pp (6-1-1) | +25.0 pp (5-3-0) | **+44 pp** |
| mcts-500ms vs search-d3     | 0 pp (4-4-0)     | — | tied at half the budget |
| mcts-500 (iter) vs greedy(v3) | +33 pp (4-2-0) | — | suggestive |

**Headline.** With 1 second per turn, MCTS clearly beats alpha-beta
depth-3 by ~+44 pp. The same MCTS at 500 ms per turn ties with
search-d3, and at smaller budgets it loses (or doesn't have enough
time to descend usefully into the tree).

Total game time at the winning configuration: mcts-1s averages
~32 s/game (vs ~6 s/game for search-d3). MCTS uses the compute we
give it; the win is *not* free.

**Interpretation.** Two things are likely going on:

1. **Opponent model.** Paranoid alpha-beta assumes the opponent picks
   whatever is worst for `me`; MCTS with random rollouts assumes
   "anything plausible could happen next." Splendor's actual opponents
   play closer to greedy than to paranoid, so the random-rollout
   model is a better fit for *how the game actually plays out*.
2. **Effective depth.** A single MCTS iteration descends to whatever
   depth the tree has been expanded to, then plays a rollout of up to
   20 random turns and evaluates. The combined "lookahead horizon" is
   in the 20–30 turn range for the most-visited branches — much
   deeper than alpha-beta-3's strict 3 plies. Even at random-rollout
   quality, the longer horizon catches consequences (e.g., gem-cap
   pressure two turns out, or noble visits four turns out) that
   alpha-beta can't see.

We don't yet have an experiment that disentangles these — Phase 3 v2
(better rollout policy, ISMCTS) will let us probe further.

## Experiment 12 — heuristic vs random rollout policy

**Hypothesis.** Pure random rollouts are noisy; replacing them with a
domain-aware playout policy should make each iteration's reward more
informative, so MCTS converges to better moves at lower compute. The
heuristic prioritizes legal actions by Splendor sense:

  1. Highest-prestige affordable buy.
  2. Any affordable buy (still grants a permanent bonus).
  3. Any take action (take3 / take2).
  4. Any reserve.

Random tie-breaking within each tier. No `applyTurn` per candidate;
the policy is just iteration + comparisons, so per-step cost is
roughly the same as pure random.

**Implementation.** `heuristicRolloutAction` in `src/game/mcts.ts`,
controlled by `MctsOptions.rolloutPolicy`. Heuristic is now the
default; pure random is available as `'random'` for A/B.

**Results (8 games per cell, seed 7):**

| Match                                | Result | Δ (pp) |
|---|---|---|
| mcts-1s (heuristic) vs mcts-1s-rand  | 5-2-1  | **+37.5 pp** |
| mcts-500ms (heuristic) vs search-d3  | 6-2-0  | **+50.0 pp** |

The second row is the headline: **at half the budget that previously
only tied search-d3 (random rollouts), heuristic MCTS now beats
search-d3 by +50 pp.** Heuristic rollouts roughly double the
effective strength per unit of compute.

**Why.** Two reinforcing reasons:

1. **Each rollout is closer to plausible play.** Random play
   under-buys (it picks any legal action uniformly, but buys are
   ~10% of legal actions on average). Heuristic play always grabs a
   real-prestige card when one is affordable, so the leaf state
   reflects "what would happen if play continued sensibly" rather
   than "what happens if everyone plays terribly for 20 turns."
2. **Lower-variance rewards.** When rollouts produce more consistent
   trajectories, UCB1's exploit term is meaningful at lower visit
   counts, so the tree concentrates visits on actually-promising
   branches faster.

## What's left for Phase 3

- **Better rollouts.** Random rollouts are weak — a greedy rollout
  policy (pick the highest 1-ply evaluator score with random
  tie-breaking) should produce more informative rewards per
  iteration. Likely a clean win.
- **Information Set MCTS (ISMCTS) with determinization.** At each
  iteration, sample a deck order and opponent reserve identities
  consistent with the active player's information set, then search
  that determinization. Many iterations across many determinizations
  Monte-Carlo over the hidden state. This is the "right" way to
  handle Splendor's hidden info.
- **Multi-player matches.** All experiments so far are 2P. MCTS with
  reward vectors generalizes naturally; verify behavior at 3–4 players.
- **Transposition tables.** Cache tree nodes by state hash so revisits
  in independent iterations share information. Big speedup possible.
- **Progressive widening.** When the action space is large (which
  Splendor's 30-ish branching is) and visit counts are modest, MCTS
  spreads its budget too thin. Progressive widening only allows
  expansion of new children once a node has been visited enough times.

## Phase 3 status

**Done:**
- `mctsBestAction(rootState, options)` with iteration or time budget.
- UCB1 selection with multi-player reward vectors.
- Depth-capped random rollouts using the v3 evaluator at the leaf.
- `mctsAgent(iterations)` and `mctsTimeAgent(timeMs)` agent shims.
- 3 unit tests (legal action, prefers clear buys, deterministic RNG).
- 1 regression match (mcts-200 ≥ greedy(v3) in 4 games).
- CLI agents: `mcts-200 / mcts-500 / mcts-1000 / mcts-2000`,
  `mcts-500ms / mcts-1s / mcts-3s`.

**Next:**
- Better rollout policy (greedy or evaluator-driven).
- ISMCTS with determinization.
- Multi-player verification.
