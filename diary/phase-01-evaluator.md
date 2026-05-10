# Phase 1 — Handcrafted evaluator

**Status:** in progress
**Started:** 2026-05-10

## Goal

Phase 0 gave us the *rules*. Phase 1 gives us *taste*: a function `evaluate(state, player) → number` that says how good a position is for a given player without searching. Once we have a sane evaluator, a one-ply greedy agent (pick the action whose resulting state evaluates highest) is already a baseline assistant. Every later technique — Phase 2 lookahead, Phase 3 MCTS — leans on this same scoring function.

By the end of Phase 1 we will have:

1. A documented mental model of *why* a Splendor position is good or bad, derived from the actual card data.
2. A first evaluator with handcrafted weights, tested against `random` and against simpler variants.
3. A tournament harness that can answer "did adding this feature actually help?" with numbers, not vibes.

## Data analysis (input to feature design)

Before sketching the evaluator we measured the real card and noble data — all 90 cards and 10 nobles, transcribed by hand into JSON via the entry tool. Five findings that *directly* shape the evaluator follow.

### F1. Splendor is perfectly color-symmetric

| Quantity | white | blue | green | red | black |
|---|---|---|---|---|---|
| Total gem demand (across 90 cards) | 117 | 117 | 118 | 118 | 117 |
| Bonus supply (cards with that bonus) | 18 | 18 | 18 | 18 | 18 |
| Total noble demand (sum across 10 nobles) | 17 | 17 | 17 | 17 | 17 |
| Demand / supply ratio | 6.50 | 6.50 | 6.56 | 6.56 | 6.50 |

**No color is intrinsically more valuable than another.** This is design balance, not coincidence. The evaluator must NEVER prefer a color in the abstract — only based on *what's available right now on the board, what opponents are doing, and which nobles are in play this game.* Implication: never bake `color × constant` weights into the evaluator. Color preference must be derived from the *current* state.

### F2. Tier-prestige-efficiency curve

| Tier | Avg cost (gems) | Avg prestige | Prestige per gem | Has prestige |
|---|---|---|---|---|
| 1 | 4.17 | 0.13 | **0.030** | 5 / 40 (13%) |
| 2 | 6.83 | 1.83 | **0.268** | 30 / 30 (100%) |
| 3 | 10.75 | 4.00 | **0.372** | 20 / 20 (100%) |

Tier 3 is roughly 12× more prestige-efficient than tier 1 — but only if you can afford it. Tier 1 is functionally an **engine layer**: 87% of tier 1 cards have *zero* prestige; their value is the permanent bonus they grant. Tier 2 transitions to scoring (every card has at least 1 prestige). Tier 3 is endgame anchors (every card 3–5 prestige).

**Implication:** the evaluator should treat tier 1 cards as *infrastructure* (their value is the bonus they enable, projected forward) and tier 2/3 as *both points and bonuses*. Bonus value must be **time-discounted** — early bonuses compound across the rest of the game; late-game bonuses might never get used.

### F3. Anchor cards force specialization

Cards needing ≥5 of one color ("anchors") count by tier:

- T1: 0 / 40 anchors
- T2: 15 / 30 anchors (50%)
- T3: 20 / 20 anchors (100%)

**Every single tier-3 card is an anchor in some color.** A player whose engine is one bonus per color (5 bonuses, all colors equal) literally cannot afford a single tier 3 card — they would still need 5+ raw gems of the anchor color in hand on top of the bonus. Real engines specialize.

**Implication:** the evaluator should reward *concentration* of bonuses, not raw count. A player with `(white=4, black=3, others=0)` is in a much stronger position than one with `(1,1,1,1,1)` despite both having 5 bonuses.

### F4. Nobles follow a 5-color cycle

Arrange the colors on a ring: `white → blue → green → red → black → white`. Pairs of *adjacent* colors on this ring appear in 3 of 10 nobles each; *non-adjacent* pairs appear in just 1 of 10 each.

| Adjacent (popular, in 3 nobles) | Non-adjacent (rare, in 1 noble) |
|---|---|
| white + blue | white + green |
| blue + green | white + red |
| green + red | blue + red |
| red + black | blue + black |
| black + white | green + black |

(All 5 noble pairs of `(4,4)` plus the `(3,3,3)` triples decompose into 20 pair-instances; 5 popular pairs × 3 + 5 rare pairs × 1 = 20.)

**Implication:** committing to two adjacent ring colors (e.g., green + red) puts a player on a path to several nobles simultaneously. Committing to non-adjacent colors (e.g., blue + red) helps at most one noble. Noble-proximity feature should weight progress along *adjacent* commitments more heavily.

### F5. Bonuses compound across the whole game

Every bonus permanently saves 1 gem on every future card matching that color. With ~117 demand of each color and a player typically buying ~12 cards over the game (~3 in each tier), a single early bonus saves ~12 × (1.30 / 5) ≈ 3 gems on average — for free, every turn it exists. Two early bonuses save ~6 gems. Five save ~15.

**Implication:** the *time horizon* on a bonus matters more than its color. An evaluator that scores bonuses at a flat rate will under-value early bonuses and over-value late ones. We need a turn-aware (or remaining-cards-aware) discount.

## Feature sketch for the evaluator

Synthesizing F1–F5, the evaluator decomposes as:

```
evaluate(state, player) =
    w_prestige     × prestige(player)
  + w_engine       × engine_value(player, state)
  + w_gems         × gem_buying_power(player)
  + w_noble        × noble_proximity(player, state)
  + w_reserve      × reserve_flex(player)
  - w_threat       × opponent_threat(state, player)
```

### prestige

Just `player.prestige`. Already cached on `PlayerState` (D4). Trivial. The evaluator should weight prestige very heavily — it's the literal score. Suggested starting weight: 1.0.

### engine_value

Not just `count(bonuses)`. Should reflect *projected savings* across the rest of the game. First-pass formula:

```
engine_value(player, state)
  = Σ over colors c:  bonuses[c] × expected_remaining_demand[c]
```

Where `expected_remaining_demand[c]` is approximated by:
- the number of cards still on the board + decks costing color `c`,
- divided by 2 to account for the fact that the player won't buy *all* of them.

A simpler v1 stand-in: use the static average demand of 1.30 gems per card per color × `cards_likely_to_be_bought` (rough constant per phase, e.g., 8 mid-game).

The **concentration bonus** from F3 is added on top:

```
concentration_bonus = max(bonuses) × small_weight
```

This rewards specialization — having 4 of one bonus and 0 of others scores higher in concentration than 1 of each.

### gem_buying_power

Sum of colored gems + ≈ 1.5 × gold (gold is worth ~50% more because it's flexible). **Heavily discount gems near the 10-gem cap** — they're at risk of forced discard, and any 11th gem is wasted.

### noble_proximity

For each noble in `state.nobles`:
```
need = Σ over colors c:  max(0, requirement[c] - bonuses[c])
proximity = (max_need - need) / max_need  // 0 = far, 1 = claimable
```

Sum over all nobles. Adjacent-pair commitments (F4) score higher because they make multiple nobles claimable from a single bonus profile.

### reserve_flex

Small bonus per reserved card — flexibility, plus the option of denying opponents. Capped (3 reserves max anyway). Slightly negative if reserved cards are unlikely to ever be affordable (junk reserves clog the hand).

### opponent_threat

Roughly: `max over opponents of (15 - their_prestige) inverted`. Closer opponents to 15 = higher threat. Used to bias toward *blocking* moves (reserve a card the opponent wants, take gems they need) when the score is close.

## Design decisions to lock in during Phase 1

- [ ] **Time discount for engine value.** Static (per-tier weight) or dynamic (turn-count-aware)?
- [ ] **Color demand source.** Fixed constant from analysis above, or recomputed each turn from visible cards + nobles?
- [ ] **Concentration bonus shape.** Linear in `max(bonuses)`, or a stronger reward like `Σ bonuses[c]²`?
- [ ] **Tournament harness format.** Fixture seeded games against `random` agent — how many runs to call a feature "validated"?

## Open questions

- Is the evaluator phase-aware (different weights early vs late) or static? Static is simpler; phase-aware is closer to how humans actually play.
- Do we model the *deck pile composition* as a probability distribution for evaluating reserve quality? Probably overkill for Phase 1 — defer to Phase 3 (MCTS / determinization).
- How do we score the gem-discard sub-decision when over the 10-cap? For the evaluator, we just evaluate the post-discard state. For *enumeration*, see Phase 0's D8.

## Pre-Phase-1 spillover (must finish before evaluator can run on real states)

- [ ] `apply(state, action)` — task #7
- [ ] `applyReveal` + `terminal` + `winner` — task #8
- [ ] `loadCardsFromJson` and `loadNoblesFromJson` so the engine sees the real deck — task #9 final step
- [ ] `project(state, player)` — task #10 (Phase 3 prep, but cheap to add now)

## Status

**Done:**
- Data analysis on real card + noble data (F1–F5 above)
- Evaluator feature decomposition sketch
- Phase 0 engine spillover closed (`apply` / `applyReveal` / `terminal` / `winner` / `initialState`)
- v1 evaluator (`prestige + 0.5 × bonus_count`) + greedy agent + tournament harness
- v2 evaluator (adds noble proximity)

## Experiments

We A/B test each new feature against the previous evaluator over many
self-play games to verify it actually helps before keeping it.

### Experiment 1 — baseline (v1) vs random

Hypothesis: even the simplest scoring function should beat random play.

**Result (10 games, seed 42):** greedy v1 won 10/10. Baseline confirmed.

### Experiment 2 — v2 (noble proximity) vs v1 baseline

Hypothesis from F4: nobles are 3 prestige each, claimed mid-game. With
only `prestige + bonus_count`, greedy has no signal that a noble is
*reachable* until the moment it claims one — too late to plan toward.
Adding a feature that scores partial progress toward each unclaimed
noble (linear, 3 × proximity_ratio per noble) should give the agent
7+ turns of forward-looking incentive to align bonuses with a noble.

**Implementation:** `nobleProximityFeature` in `src/game/evaluate.ts`.
For each unclaimed noble in `state.nobles`, sums:

```
proximity_ratio = (max_need - remaining_need) / max_need
score          += 3 * proximity_ratio
```

Weight 1.0 in `FEATURES_V2`.

**Result (50 games, seed 7):**

| Agent              | Wins | %    |
|---|---|---|
| greedy(v2)         | 26   | 52.0 |
| greedy(baseline)   | 16   | 32.0 |
| draws              | 8    | 16.0 |

v2 advantage: **+10 games, +20 percentage points.** Hypothesis
confirmed; v2 keeps the slot. Tournament regression test in
`tournament.test.ts` asserts v2 wins at least as many head-to-head
games as baseline; the bar is conservative so RNG variance doesn't
flake.

Try it yourself:

```
npm run compare 50 7    # head-to-head, 50 games, seed 7
npm run play            # one game, narrated
npm run match 30        # greedy vs random, 30 games
```

## Next features queued (in expected impact order)

1. **Color concentration bonus** (F3) — reward `max(bonuses)` so a
   tall white tower beats a flat one of each. Should help T2/T3
   anchor cards become reachable.
2. **Engine value with color demand** (F5) — replace the flat
   `0.5 * bonus_count` with `Σ bonuses[c] * remaining_demand[c]` where
   demand is computed from cards still on the board. Should make the
   evaluator phase-aware automatically.
3. **Opponent threat** — penalty proportional to opponents' prestige.
   Triggers blocking moves when the game is close.
4. **Gem hand-cap pressure** — score gems above ~7 at a discount
   (close to forced discard). Discourages hoarding.
