# Phase 0 — Formalize Splendor as a decision problem

**Status:** in progress
**Started:** 2026-05-10

## Goal

Before we write a single line of AI code, we must answer: *what is the math of Splendor?* Specifically, we need to characterize Splendor as a formal decision problem so that every later technique (heuristic search, minimax, MCTS, ISMCTS, RL) has a precise foundation to build on.

By the end of Phase 0 we will have:

1. A mental model of Splendor as a tuple ⟨S, A, T, U, P⟩.
2. A clear answer to "what is hidden, what is random, and what is observable?"
3. A TypeScript encoding of game state, actions, and the legal-action function.
4. Tests that pin down the tricky rule edges.

## Theory

### 1. A game, formally

A turn-taking game can be modeled as a tuple:

- **S** — the set of states. Each state captures *everything that matters* about a position.
- **A(s)** — the legal actions available in state `s`. The *active player* picks one.
- **T(s, a)** — the transition function. Given a state and an action, returns the next state. May be **stochastic** (returns a distribution over states).
- **U_i(s)** — the utility for player `i` in state `s`. For Splendor, the simplest definition is: 1 if `i` won, 0 otherwise. (We can refine later — e.g., margin of victory.)
- **P** — the set of players. For us, `|P| ∈ {2, 3, 4}`.

Plus: a function `currentPlayer(s)` that says whose turn it is, and `terminal(s)` that says when the game is over.

This abstraction is the ground floor for *every* AI technique we will use. Minimax searches the tree induced by `T`. MCTS samples rollouts under `T`. RL learns a policy that picks `a ∈ A(s)`. Get the encoding right and everything composes; get it wrong and every algorithm above is subtly broken.

### 2. Splendor's rules in one place

So we have a shared reference, here is the canonical rule set we will encode:

**Setup.**
- 5 colored gem types: white (diamond), blue (sapphire), green (emerald), red (ruby), black (onyx). Plus **gold** (joker, only obtainable via reserve).
- Gem supply by player count: 4 players → 7 of each colored + 5 gold; 3 players → 5 each + 5 gold; 2 players → 4 each + 5 gold.
- 90 development cards in 3 tiers: 40 (level 1), 30 (level 2), 20 (level 3). Each tier is a shuffled deck; 4 cards from each tier are face-up on the board.
- Each card has: a colored cost (counts of each gem color), a permanent **bonus** (one gem color), and prestige points (often 0–5).
- Nobles: `numPlayers + 1` are dealt face-up. Each requires a set of bonuses (e.g., 3 white + 3 blue) and is worth 3 prestige.
- Win condition: when at least one player reaches 15 prestige, the round is finished and the player with the most prestige wins (tiebreaker: fewer purchased cards).

**Turn.** Exactly one of:
1. **Take 3 different colors** from the gem supply (must be 3 distinct colors with ≥1 available; if fewer than 3 colors have any gems, take what you can).
2. **Take 2 of the same color** — only legal if that pile has **≥4** before you take.
3. **Reserve a card** — pick a face-up card or the top of any deck (blind). Add it to your reserve hand (max 3 reserved). If a gold is available in the supply, take it.
4. **Buy a card** — pay its cost from gems + bonuses; gold is a wildcard. Card may be on the board or in your reserve.

**End of turn:** if you have >10 gems (including gold), return some until you are at 10.

**Noble visit:** at the end of your turn, if you meet a noble's bonus requirement, you claim it (one per turn in standard rules). Noble bonuses are *not* spent — they are a check on your tableau.

### 3. Information structure: what the agent sees vs. what the game knows

Splendor is **imperfect information** — there are facts about the game state that some players cannot see:

- **Order of cards in each tier deck.** When a face-up card is bought or reserved, the next card from that deck is revealed. The order is hidden until reveal.
- **Reserved cards held by opponents.** When you reserve face-down (top of deck) or hold any reserved card, opponents do not see its identity (in standard rules — house variants differ).

Everything else is public: gem supply, the 12 face-up cards, every player's tableau (purchased cards), every player's gem hand, every player's prestige, the nobles in play, the count of cards remaining in each deck.

This matters because optimal play depends on *information sets*, not states. Two states that look identical to me but differ in opponent reserves are, from my perspective, the same decision problem. The right formalism is:

> A player `i`'s **information set** at state `s` is the set of all states the player cannot distinguish from `s` given their observations.

Phase 3 (ISMCTS) leans hard on this. We need our model to support deriving the information set from the full state.

### 4. Stochasticity

Splendor has a chance element: when a face-up card is removed, a card is drawn from the top of that tier's deck to refill. Since deck order is hidden, this is a **chance node** in the game tree. Some encodings represent it as a player called "Chance" with a known probability distribution over actions.

In code, we have two modeling choices:

- **Eager refill (random).** When `T(s, buy/reserve)` removes a face-up card, immediately draw the next one. `T` becomes a stochastic function.
- **Lazy refill (deterministic + reveal action).** Leave the slot empty; insert a "reveal" chance step that the simulator handles.

Both work. Eager is simpler for early phases; lazy is cleaner for MCTS where we want to control sampling.

### 5. Branching factor (back-of-envelope)

For a typical mid-game state:

| Action type            | Approx count |
|------------------------|--------------|
| Take 3 different       | C(5,3) = 10  |
| Take 2 same            | up to 5      |
| Reserve face-up        | up to 12     |
| Reserve from deck top  | up to 3      |
| Buy face-up            | up to 12     |
| Buy from reserve       | up to 3      |
| **Total**              | **30–45**    |

Plus the "return down to 10" gem-discard sub-decision when over the cap, which multiplies things further.

For comparison: chess ≈ 35, Go ≈ 250. Splendor sits in the chess range — search-friendly.

But: with 4 players, the game tree branches by ~`b^P` per "round" instead of `b^2`. That is the cost of multi-player.

### 6. Multi-player wrinkle

Two-player zero-sum games have minimax. With 3+ players we need different tools:

- **max^n** — each player maximizes their own utility. Honest but ignores coalitions.
- **paranoid** — assume all opponents collude against the active player. Pessimistic but lets you reuse alpha-beta pruning.
- **MCTS** — handles multi-player naturally; each rollout simulates each player playing for themselves.

We will revisit this in Phase 2. Phase 0 just needs `currentPlayer(s)` and the ability to track per-player utilities.

## Design decisions

### D1. Perspective: god-view + derived information set

`GameState` is the engine's full ground truth — including ordered decks and every player's reserved cards. A pure function `project(state, player) → InformationSet` produces what a given player can see. The AI agent always reasons from an information set; the engine simulates from `GameState`.

**Why:** ISMCTS in Phase 3 requires sampling consistent ground-truth states from an information set. We cannot do that if our base type only encodes what one agent sees. Doing this correctly from day one is much cheaper than retrofitting later.

### D2. Refill: lazy reveal

When a face-up card leaves the row (bought or reserved), the slot becomes empty and a `pendingReveal` is queued. A separate `reveal` chance step (drawn from the deck) fills it. The engine applies reveals automatically by default, but the API surface lets us *intercept* the chance event for MCTS.

**Why:** This separates "what the player decided" from "what the world rolled." For MCTS determinization, we need to inject sampled deck orders consistently — a separate reveal step is the standard formalism for that.

### D3. Player count: 2–4 parameterized

`numPlayers ∈ {2, 3, 4}` is a state field. Gem supply and noble count derive from it. No 2-player-only assumptions baked in.

**Why:** matches the user's actual use case (real games with friends), and forcing the abstraction now means our minimax/MCTS code is multi-player from the start — which is harder than 2P, but only marginally if we plan for it.

## Experiments / observations

### First implementation pass (2026-05-10)

Wrote `src/game/types.ts`, `src/game/gems.ts`, `src/game/legalActions.ts`, `src/game/fixtures.ts`, and a 12-case test suite. All passing.

**What clicked:**
- Modeling `bonuses` and `prestige` as derived (computed from `purchased` and `nobles`) rather than stored cleanly eliminates a class of "two sources of truth" bugs. Worth the recompute cost — it's O(cards owned), max ~20.
- `kSubsets` falling back from k=3 to k=2 to k=1 elegantly handles the depleted-supply edge case for "take 3 different." A naive `C(5, 3)` enumeration would have missed it.
- Bonuses-before-gems-before-gold is the correct payment ordering. Gold is precious — never spend it where a colored gem could pay.

**What we deferred:**
- Discard enumeration for over-cap take/reserve actions. Phase 0 `legalActions` returns base actions only; the `apply` step will need to either reject over-cap actions or take a discard parameter. We'll resolve when we implement `apply`.
- Real Splendor card data (90 cards + 10 nobles). We've been testing with fixture cards. Transcribing the rulebook is mechanical but necessary before any meaningful evaluator work in Phase 1.

## Open questions

- How will we handle the gem-return sub-decision when a player exceeds 10? As a separate action, or folded into the parent action's parameters?
- Do we expose noble-tiebreaker logic (when multiple nobles are claimable simultaneously, the player chooses)? Or auto-claim the first match?
- Final game-end check: standard rules end the *round* when someone hits 15. Do we model "round end" or just "turn ends after everyone got equal turns"?
- Should `project(state, player)` also hide the *count* of opponents' reserved cards? In standard play that count is visible (cards held face down on the table), so we'll keep counts public and only hide identities.

## Phase 0 status

**Done:**
- ⟨S, A, T?, U?, P⟩ characterization in writing
- Information / stochasticity / branching analysis
- Three modeling decisions (D1 god-view, D2 lazy reveal, D3 2–4 players)
- TypeScript encoding of `GameState`, `Action`, `Card`, `Noble`, `PlayerState`
- `legalActions(state)` with 12 passing tests

**Deferred to Phase 0.5 / spillover (see task list):**
- `apply(state, action)` — the transition function `T`
- `applyReveal` + `terminal`/`winner` — the chance steps and `U`
- Real card + noble data
- `project(state, player)` — information-set derivation


## Open questions

- How will we handle the gem-return sub-decision when a player exceeds 10? As a separate action, or folded into the parent action's parameters?
- Do we expose noble-tiebreaker logic (when multiple nobles are claimable simultaneously, the player chooses)? Or auto-claim the first match?
- Final game-end check: standard rules end the *round* when someone hits 15. Do we model "round end" or just "turn ends after everyone got equal turns"?
