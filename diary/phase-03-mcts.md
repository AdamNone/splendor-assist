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

## Infrastructure — parallel tournament harness

Tournament experiments became the time bottleneck (search-d3 vs v3 over
30 games = ~3 minutes; MCTS comparisons multiples of that). Sequential
games are independent, so we now run them across a worker pool.

**Implementation.** `playMatch` is now async; if both agents are passed
as `AgentDescriptor` (`{ name, seed? }`), it spawns `cpus().length - 1`
worker threads. Each worker reconstructs its assigned agent from the
descriptor + seed via `makeAgent` and runs one game per assigned spec.
Sequential mode (function-typed agents) is preserved unchanged for
existing regression tests.

Workers can't inherit tsx's import hooks from the main thread, so a
tiny `.mjs` bootstrap (`tournament-worker-bootstrap.mjs`) registers
tsx before importing the TS worker file. With that in place the
worker imports our regular `src/game/` modules normally.

**Speedup measurement (30 games, search-d3 vs greedy(v3), seed 7):**

  Before parallelization : ~186 s
  After  parallelization : ~48 s   (3.9× faster, 754% CPU)

Worker pool gives near-linear speedup up to core count. The two CLI
runs above produced identical results (16-12-2) — game *content* is
deterministic regardless of worker count, only execution speed differs.

**Caveat: time-budgeted agents (mcts-500ms, mcts-1s, iter-N) get
throttled in parallel mode.** Wall-clock budgets aren't aware of CPU
sharing — under 7-way contention each worker sees only ~1/7 of real
CPU per 1 s of wall clock, so MCTS does ~7× fewer iterations than
single-threaded. Spot check: `mcts-500ms` vs `v3` in parallel showed
-30 pp (mcts much weaker than expected) where `mcts-500` (iter-budget)
still wins +50 pp at the same 20-game seed. **Use iteration budgets
when running parallel matches.**

## Experiment 13 — ISMCTS with deck-shuffle determinization

**Hypothesis.** Splendor's deck order is genuinely hidden. Plain MCTS
plays through `applyTurn`, which deterministically reveals the top of
the deck — so the agent's tree is shaped around a future the agent
*shouldn't actually know*. Information Set MCTS samples a fresh
determinization at each iteration (shuffles each tier's deck) so the
tree's visit statistics average over deck-order uncertainty.

**Implementation.** `determinize(state, rng)` in `src/game/mcts.ts`
returns a new state with each tier's deck shuffled (Fisher-Yates).
`MctsOptions.determinization = true` makes each MCTS iteration begin
with a fresh shuffle. New CLI agents: `ismcts-200`, `ismcts-500`,
`ismcts-1000`, `ismcts-500ms`, `ismcts-1s`.

v1 scope: deck order only. Opponents' blind-reserved card identities
are still visible (god view); proper handling sampling from the
unknown pool is queued for v2.

**Results (30 games per match, seed 7):**

| Match                             | Result   | Δ (pp) |
|---|---|---|
| ismcts-500 vs mcts-500            | 12-16-2  | **−13.3 pp** |
| ismcts-500 vs greedy(v3)          | 20-6-4   | **+46.7 pp** |

ISMCTS is decisively weaker than plain MCTS at the same iteration
budget in our tournament. It still crushes greedy.

**Interpretation.** This result is expected once you look closely at
the tournament setup. Both agents play through the engine's
`applyTurn`, which always reveals the deterministic top of the deck.
Plain MCTS's tree is shaped around exactly that future — it focuses
all iterations on what's actually going to happen. ISMCTS averages
over orderings that *won't* happen in this environment, so it
"spends" some iterations on counterfactual futures and gets less
signal per iteration about the real one.

The asymmetry that matters for the assistant: **the tournament
environment isn't representative of real play.** In a real Splendor
game, the deck order is genuinely random at the moment of reveal —
the agent's model of "what comes next" has to be probabilistic, not
deterministic. The tournament can't easily measure this because both
agents have a god-view engine state.

**Decision.** Keep ISMCTS as an option. Plain MCTS remains the
tournament champion. For real-world deployment the choice is:

- Use plain MCTS when the engine's `applyTurn` reveals are
  deterministic (CPU tournaments, internal A/B testing).
- Use ISMCTS when reveals are genuinely random (real game play, or
  if we add stochastic reveals to the simulator for evaluation).

The 47 pp advantage over greedy confirms the determinization
machinery isn't broken — it's correctly producing strong play, just
not strictly more optimal than plain MCTS in this environment.

## Experiment 14 — reward shaping: bands and a speed discount

**Where it came from.** Not from the tournament — from reviewing a real
logged 3-player game. On turn 76 the assistant recommended `take3 W`
while a `buy T3-018` was on the board that scored +7 in one move (a
4-prestige card whose black bonus also completed a 3-prestige noble).
Taking it would have ended the game three turns earlier. The user
followed the recommendation and won by two points, one blunder away
from losing.

**Diagnosis.** Dumping the root's candidates at full precision:

```
1.000000000000    71v  take3 W
1.000000000000    71v  take3 B
...
1.000000000000    71v  buy T3-018 (4p, +black) paying 2R 2g
...
candidates with meanReward EXACTLY 1.0: 16 / 30
```

Sixteen root moves, identical scores, identical visit counts. Not a
rounding artefact — a genuine 16-way tie.

Two independent causes:

1. **No time preference.** Terminal rollouts paid 1 for a win and 0 for
   a loss. From a position this far ahead, the heuristic playout policy
   wins from *every* move (measured: 68–100% per candidate), so every
   move scored 1.0. "Win in one move" and "win in six" were literally
   the same number.
2. **The tie-break was positional.** `finalizeStats` picked the first
   child reaching the maximum visit count, i.e. whichever action
   `legalActions` happened to list first.

A third, smaller thing fell out of the same investigation: `squash(x) =
sigmoid(x/5)` is saturated over the whole useful range. Evaluator scores
run 0..40; sigmoid hits 0.75 at x=5.5 and 0.99 at x=23. So a *heuristic
estimate* of a good position (~0.998) could outscore a real, slower win,
and the assistant's percentage column read as a wall of 100%.

**Change.** `RewardShaping = 'binary' | 'discounted'`, defaulting to
`discounted`:

- Three separated bands — loss `[0, 0.35)`, undecided `[0.35, 0.65]`,
  win `(0.65, 1]` — so no heuristic estimate can ever outrank a real
  win, and no real loss can outrank an estimate.
- Inside the win band, value decays as `0.85^plies`, counting plies from
  the *root* (nodes carry a `depth` so a rollout starting deep in the
  tree isn't credited as fast).
- Undecided leaves score on *margin* — my evaluator score minus the best
  opponent's — through `sigmoid(margin / 8)`. Centred on zero, so it
  actually uses its band instead of pinning at the top.
- `finalizeStats` breaks visit ties on mean reward.

`'binary'` is kept, and wired up as `mcts-500-binary` / `-1000-` /
`-2000-`, purely so `compare` can A/B the two.

**Does it find the move? (turn 76, 10 seeds per cell)**

| shaping | 100 it | 300 it | 1000 it | 3000 it |
|---|---|---|---|---|
| binary     | 0/10 | 0/10 | 0/10 | 0/10 |
| discounted | 0/10 | 0/10 | **10/10** | **10/10** |

Worth separating the two fixes. On turn 82 — the actual winning turn —
the tie-break change alone was enough: binary shaping plus the new
tie-break already finds `T3-018` 10/10 at every budget, where the old
code recommended a 1-prestige card. Turn 76 is the harder case and needs
the discount; the tie-break does nothing for it, because the scores
there were exactly equal rather than merely close.

**The budget cliff is the interesting part.** Below ~1000 iterations the
discount doesn't rescue turn 76 either: with ~30 root candidates and 300
iterations each arm gets ~10 visits, and a mean-reward gap of ~0.06
cannot survive that much noise. The fix buys resolution, not
clairvoyance. Progressive bias (a heuristic prior in UCB1, decaying as
`1/(visits+1)`) is the standard way to make low budgets rank sensibly and
is the obvious next experiment.

**Effect on game review.** The Phase-G blunder review previously scored
this game at `totalLoss 7.2%, meanLoss 0.26%` and never listed turn 76 —
because loss is measured against MCTS's own pick, so a saturated search
reports zero regret exactly where it is blindest. It now reports
`totalLoss 14.4%` with turn 76 as the top entry at −8.4%, seven times
larger than anything else in the game.

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
