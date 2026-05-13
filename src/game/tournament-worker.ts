import { parentPort } from 'node:worker_threads';
import { applyTurn, isTerminal, winner } from './apply';
import { makeAgent, type AgentDescriptor } from './agentFactory';
import { legalActions } from './legalActions';
import { initialState, seededRng } from './setup';

type GameRequest = {
  gameIndex: number;
  /** Seed used to deal the initial state. */
  stateSeed: number;
  /** Which seat is agent A. */
  seatA: 0 | 1 | 2 | 3;
  numPlayers: 2 | 3 | 4;
  maxTurnsPerGame: number;
  agentA: AgentDescriptor;
  agentB: AgentDescriptor;
};

type GameResult = {
  gameIndex: number;
  /** Index of the winning player. null = draw / stall. */
  winnerPlayer: number | null;
  /** Was the result a stall (no legal action / max turns)? */
  stalled: boolean;
  turnsPlayed: number;
};

const runGame = (req: GameRequest): GameResult => {
  const agentASeed = req.agentA.seed ?? 0;
  const agentBSeed = req.agentB.seed ?? 0;
  const fnA = makeAgent(req.agentA.name, agentASeed);
  const fnB = makeAgent(req.agentB.name, agentBSeed);
  if (fnA === null) {
    throw new Error(`tournament-worker: unknown agent A "${req.agentA.name}"`);
  }
  if (fnB === null) {
    throw new Error(`tournament-worker: unknown agent B "${req.agentB.name}"`);
  }

  let s = initialState(req.numPlayers, { rng: seededRng(req.stateSeed) });
  let stalled = false;
  while (!isTerminal(s) && s.turnNumber < req.maxTurnsPerGame) {
    if (legalActions(s).length === 0) {
      stalled = true;
      break;
    }
    const me = s.currentPlayer;
    const agent = me === req.seatA ? fnA : fnB;
    const action = agent(s);
    s = applyTurn(s, action);
  }

  if (stalled || s.turnNumber >= req.maxTurnsPerGame) {
    return {
      gameIndex: req.gameIndex,
      winnerPlayer: null,
      stalled: true,
      turnsPlayed: s.turnNumber,
    };
  }
  return {
    gameIndex: req.gameIndex,
    winnerPlayer: winner(s),
    stalled: false,
    turnsPlayed: s.turnNumber,
  };
};

const port = parentPort;
if (port === null) {
  throw new Error('tournament-worker must run in a Worker context');
}

port.on('message', (req: GameRequest) => {
  try {
    const result = runGame(req);
    port.postMessage({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({ ok: false, gameIndex: req.gameIndex, error: message });
  }
});
