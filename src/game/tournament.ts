import { applyTurn, isTerminal, winner } from './apply';
import { legalActions } from './legalActions';
import { initialState, type Rng } from './setup';
import type { Agent } from './agents';
import type { GameState, PlayerIndex } from './types';

export type MatchOptions = {
  games: number;
  numPlayers?: 2 | 3 | 4;
  rng?: Rng;
  /** Cap to prevent runaway games — if a state is unwinnable, declared a draw. */
  maxTurnsPerGame?: number;
  /** If set, called once per turn for diagnostic / narration purposes. */
  onTurn?: (state: GameState, gameIndex: number) => void;
  /** If set, called at the end of each game. */
  onGameEnd?: (state: GameState, gameIndex: number, winnerIdx: number | null) => void;
};

export type MatchResult = {
  aWins: number;
  bWins: number;
  draws: number;
  totalTurns: number;
};

/**
 * Runs `games` matches between two agents. For 2-player matches, alternates
 * who starts each game so first-mover bias washes out. For 3-4 player matches,
 * agentA plays seat 0 and agentB plays every other seat (a coarse approximation
 * — multi-agent tournaments come later).
 *
 * If both agents reach a state with no legal actions, the game is declared a
 * draw. Same if `maxTurnsPerGame` is hit.
 */
export const playMatch = (
  agentA: Agent,
  agentB: Agent,
  opts: MatchOptions,
): MatchResult => {
  const numPlayers = opts.numPlayers ?? 2;
  const rng = opts.rng ?? Math.random;
  const maxTurns = opts.maxTurnsPerGame ?? 400;
  const result: MatchResult = { aWins: 0, bWins: 0, draws: 0, totalTurns: 0 };

  for (let g = 0; g < opts.games; g++) {
    let s = initialState(numPlayers, { rng });
    // 2-player: alternate seats so each agent gets equal first-mover frequency.
    // 3-4 player: agent A is seat 0, B controls the rest.
    const seatA: PlayerIndex =
      numPlayers === 2 ? ((g % 2) as PlayerIndex) : 0;

    let stalled = false;
    while (!isTerminal(s) && s.turnNumber < maxTurns) {
      if (legalActions(s).length === 0) {
        stalled = true;
        break;
      }
      const me = s.currentPlayer;
      const agent = me === seatA ? agentA : agentB;
      const action = agent(s);
      s = applyTurn(s, action);
      opts.onTurn?.(s, g);
    }
    result.totalTurns += s.turnNumber;

    if (stalled || s.turnNumber >= maxTurns) {
      result.draws += 1;
      opts.onGameEnd?.(s, g, null);
      continue;
    }

    const w = winner(s);
    if (w === seatA) result.aWins += 1;
    else result.bWins += 1;
    opts.onGameEnd?.(s, g, w);
  }

  return result;
};
