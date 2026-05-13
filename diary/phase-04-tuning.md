# Phase 4 — Evaluator iteration & weight tuning

**Status:** in progress
**Started:** 2026-05-13

## Goal

Phase 1 produced v3 (prestige + bonus_count + noble_proximity + opponent_threat). Phase 4 picks up the thread and asks: **how much further can a hand-crafted evaluator go, and what process gets us there reliably?**

By the end of Phase 4 we will have:

1. A versioned chain of evaluators (v4 → v9) with each step documented and measured.
2. A coordinate-descent **tuner** that searches the weight space programmatically.
3. A clear understanding of the **measurement pitfalls** (seat asymmetry, overfitting, sample noise) that make naive tournaments lie.
4. A documented plan for "what we would do next if compute weren't a constraint."

## Evaluator chain

Each version adds one or two features (or reweights existing ones) on top of the previous.

### v4 — opponent noble proximity

`opponent_noble_proximity` mirrors the existing `noble_proximity` but sums across opponents and negates the result. Without it, an opponent four bonuses deep on a noble was invisible to the evaluator until they actually claimed the noble — the engine cheerfully left a +3 prestige swing on the board.

**Tournament (80 games, greedy):** v4 vs v3 → +11.3pp net.

### v5 — endgame race mode

Splendor's late game has a different shape than mid-game: once anyone hits ~12 prestige the game can end inside a single round. Re-weight the v4 stack when `isEndgame(state)` is true (any player ≥ 12 prestige):

| Feature | mid-game | race-mode |
|---|---|---|
| prestige | 1.0 | **2.5** |
| bonus_count | 0.5 | **0.2** |
| noble_proximity | 1.0 | **1.5** |
| opponent_threat | 0.5 | **1.0** |
| opponent_noble_proximity | 0.5 | **1.0** |

**Tournament:** v5 vs v4 → +13.8pp net.

### v6 — opponent 1-ply lookahead with noble chain

The existing `opponent_threat` measures *total* affordable prestige across an opponent's options. That treats "they can afford 5 different cards" as 5× the threat, even though they can only buy one next turn. `opponent_next_buy` instead asks: of all the cards each opponent could buy right now, what's the *worst-case prestige swing* — **including any noble they'd claim from the buy**?

The noble chain is the killer detail. A player with 4 green bonuses sitting on a green-bonus card they can afford is one buy away from `+card_prestige + 3` (the noble). The pure opponent_threat saw the card but missed the noble.

**Tournament:** v6 vs v5 → +6.3pp. Cumulative v6 vs v3 → +3.8pp at 2P, **regressed at 4P (-5pp)**.

### v7 — normalize opponent features per player count

v6's 4P regression came from the opponent features scaling linearly with opponent count. In 4P all three opponent features were ~3× their 2P magnitude, biasing the agent into stale defensive play (88% draws in 4P, both agents stalling).

Fix: divide each opponent feature by `numPlayers - 1`. Each feature now represents *average threat per opponent* rather than total.

**Tournament:** v7 vs v3 consistent across all player counts (+3.8pp at 2P, 3P, 4P).

### v8 — self next-buy with competition discount

Mirror of `opponent_next_buy` for the active player. Looks at every face-up and reserved card I can afford and computes prestige + any noble chain.

The first iteration was a 2P beast (+26pp) but regressed in 3P/4P, because the engine eagerly raced to the highest-prestige shared face-up cards that opponents would snatch first. Fix: **competition discount** — each face-up card's value scaled by `1 / (1 + competitors_who_can_afford_it)`. Reserved cards mine alone, no discount.

**Tournament:** v8 vs v7 → +23.8pp at 2P, flat at 3P/4P. Strictly ≥ v7 everywhere.

### v9 — per-player-count tuned weights

Run the coordinate-descent tuner separately for 2P / 3P / 4P. Multi-seed averaging across 4 distinct seed blocks (stride 7919). Final dispatcher picks the weight vector based on `state.players.length`.

**Validated (baseline-subtracted, both tune seed=1 and held-out seed=99):** +5pp avg in 2P, within-noise at 3P/4P.

## The tuner

`src/cli/tune.ts` — coordinate-descent search over the seven mid-game weights of v9. Uses the parallel `playMatch` worker infrastructure: candidates are encoded as `tunable:1.0,0.5,...` agent descriptors, and `agentFactory` parses the prefix to reconstruct an evaluator in each worker.

```
npm run tune -- <numPlayers> <gamesPerEval> <passes> [seed]
```

Multi-seed averaging is **critical**. The first tuner pass used a single fixed seed for every candidate's tournament. Coordinate descent ratcheted on coincidences in that specific game sequence; the resulting weights won +5pp on the tuning seed and **lost -32.5pp on a held-out seed**. Fixed by splitting the games budget across 4 distinct seed blocks per evaluation (`src/cli/tune.ts:runMatch`).

## Lessons learned

### Lesson 1: Overfitting is real and immediate

A tuner that replays the same game sequence for every candidate will find weights that exploit that specific sequence — not general strategy. Solution: multi-seed averaging *during* tuning, plus held-out seed validation *after*.

### Lesson 2: Tournament protocol has a hidden seat bias in 3+ players

`src/game/tournament.ts:113` pins agent A to seat 0 in 3+P matches, while agent B controls the remaining 2-3 seats. Consequences:

- `v8 vs v8` in 3P seed=99 shows **-26pp** before anyone tunes anything.
- All 3+P tournament numbers must subtract the self-match baseline to surface real signal.
- The tuner's relative ranking remains valid (every candidate plays from the same seat-0 slot), but absolute advantage numbers are unreadable without correction.
- Compounds with the fact that **seat 0 always starts** in our engine (`startingPlayer: 0` in `src/game/setup.ts`), giving A a slight first-mover advantage that partially offsets the many-opponents disadvantage.

### Lesson 3: Greedy depth-1 produces too many draws

80-game tournaments often have 50-70% draws because both greedy agents stall before reaching 15 prestige. With only ~25-40 decisive games per match, single-tournament noise is ±5pp, which swallows most weight-change signals.

### Lesson 4: Per-player-count weights are real, but the differences are modest

The tuner finds genuinely different optima per player count (2P prefers offense, 4P prefers defense + more bonuses), but the *magnitude* of the improvement vs a universal v8 is small (a few pp). Most weight changes are within the noise floor of 80-game matches.

### Lesson 5: Engine sub-optimality at the cap

`legalActions` originally generated take-3 only when the full size fit under the 10-gem cap. A player at 9 gems with 5 colors in supply got *zero* take actions and was told they had "no legal moves." Fixed by clamping take size by headroom: `Math.min(3, availableColors, headroom)`. The rules already support partial takes when supply is limited; this lets the hand cap do the same shrink.

## The "no compute constraint" plan

What we'd do next given unlimited hardware and time. Roughly ordered by expected impact.

### Phase 1: Fix the measurement (cheap, must-do)

| What | Why |
|---|---|
| **Seat-rotate tournaments in 3+P** (`seatA: g % numPlayers`) | 1-line fix. Eliminates the systematic bias that fooled us into chasing phantom regressions. |
| **Switch comparison agents to MCTS-300 or search-d3** | Greedy at depth 1 → 60–87% draws → tiny decisive sample. MCTS resolves games. |
| **1000+ games per evaluation** | At ±1pp noise we can detect 2–3pp improvements reliably. |
| **Cross-validation seeds** | Tune on seeds 1–100, validate on 101–200. Reject weights that don't beat baseline on *both* sets. Would have caught the original v9 overfit immediately. |

### Phase 2: Better search algorithm

| What | Why |
|---|---|
| **Bayesian optimization** (Optuna or a Gaussian-process surrogate) | 7-D weight space, expensive evals, smooth landscape — textbook BO. Finds optima in 100–500 evals instead of thousands. |
| **CMA-ES** as a strong alternative | Doesn't assume smoothness, handles multi-modal landscapes. |
| **Tune mid-game AND race-mode weights together** | Race-mode is currently hand-picked v5 defaults. Probably suboptimal. |
| **Train against a panel** (v3 / v7 / v8 / search-d2 / MCTS) | Currently we tune vs v8 only — risk of weights that specifically exploit v8 weaknesses. Tuning against a mix forces generalization. |

### Phase 3: Better features

| Feature | What it captures |
|---|---|
| **Discard penalty** | Cost of being over 10 gems and forced to dump. |
| **Multi-turn buy planning** | "After this take, I can buy X next turn, then Y after." |
| **Opponent gem squeeze** | Cap-pressured opponents play worse. |
| **Specific T3-anchor proximity** | "I'm clearly building toward this 5-prestige T3" vs "I have 5 white bonuses." |
| **Feature interactions** | `prestige × race-mode-active`, `noble_proximity × turns-left` — non-linear effects. |

### Phase 4: Architectural changes

| What | Why |
|---|---|
| **ISMCTS** for hidden-info handling | Blind reserves currently engine-guess one card; ISMCTS samples over all possible deck orderings. ~5–10pp in 2P, less in 4P. |
| **Live engine: MCTS with v9 inside, more iterations** (currently 300 → 1000–2000) | Linear cost, linear quality. The 300 cap was for browser responsiveness. |
| **Neural-net evaluator trained via self-play** (AlphaZero-style) | Weeks of compute, but it'd dominate any hand-crafted evaluator. |

### Order of operations

1. Tournament protocol fix (10 min of code; verification is one `v8 vs v8` self-match per player count).
2. MCTS-300 as comparison agent + 1000-game samples + CV split (1 hour code + ~5 hours of tuning runs).
3. Bayesian optimization tuner (1–2 hours code + ~1 hour tuning).
4. Re-tune mid-game AND race-mode weights, per player count (the BO run).
5. Add the missing features (1–2 days code + measurement).
6. ISMCTS (1–2 days).
7. NN evaluator via self-play (weeks).

Steps 1–4 would probably give another 5–15pp on top of v9. Step 5 another 3–8pp. Step 6 another 5–10pp in 2P. Step 7 dominates but at dramatic cost.

## Open questions

1. Do real Splendor positions have **seat-specific strategy** (i.e., does optimal play really depend on whether I'm seat 0 vs seat 2), or does turn order only matter via "first-mover advantage" and "more cards revealed before my turn"? If the latter, the seat asymmetry is a smaller deal than it looks.
2. How does v9 fare against **MCTS opponents** (not just greedy)? The evaluator goes inside MCTS rollouts — if a weight set is great for shallow greedy but mediocre for rollouts, MCTS-vs-MCTS would show very different rankings.
3. Is the **competition discount** in `self_next_buy` (1 / (1 + competitors)) the right shape, or should it be `1 / (1 + α × competitors)` for some tunable α? Worth tuning.
4. What's the right **endgame threshold**? We use 12 prestige; might be 11 or 13 depending on player count.
