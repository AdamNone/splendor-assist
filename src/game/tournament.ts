import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { applyTurn, isTerminal, winner } from './apply';
import { isAgentDescriptor, makeAgent, type AgentDescriptor } from './agentFactory';
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
  /** Worker thread count for parallel mode. Default = cpu count - 1. */
  concurrency?: number;
};

export type MatchResult = {
  aWins: number;
  bWins: number;
  draws: number;
  totalTurns: number;
};

export type AgentArg = Agent | AgentDescriptor;

type GameSpec = {
  gameIndex: number;
  stateSeed: number;
  seatA: PlayerIndex;
  numPlayers: 2 | 3 | 4;
  maxTurnsPerGame: number;
};

/**
 * Pre-compute game specs (seat assignments + initial-state seeds) so
 * sequential and parallel runs produce identical results for the same
 * `opts.rng`. Without this, parallel runs would deal differently because
 * games complete out of order.
 */
const buildSpecs = (opts: MatchOptions): GameSpec[] => {
  const rng = opts.rng ?? Math.random;
  const numPlayers = opts.numPlayers ?? 2;
  const maxTurns = opts.maxTurnsPerGame ?? 400;
  const specs: GameSpec[] = [];
  for (let g = 0; g < opts.games; g++) {
    specs.push({
      gameIndex: g,
      stateSeed: Math.floor(rng() * 2_000_000_000),
      seatA: numPlayers === 2 ? ((g % 2) as PlayerIndex) : 0,
      numPlayers,
      maxTurnsPerGame: maxTurns,
    });
  }
  return specs;
};

const accumulate = (
  acc: MatchResult,
  seatA: PlayerIndex,
  winnerPlayer: number | null,
  turnsPlayed: number,
): void => {
  acc.totalTurns += turnsPlayed;
  if (winnerPlayer === null) {
    acc.draws += 1;
    return;
  }
  if (winnerPlayer === seatA) acc.aWins += 1;
  else acc.bWins += 1;
};

const resolveAgent = (a: AgentArg): Agent => {
  if (!isAgentDescriptor(a)) return a;
  const agent = makeAgent(a.name, a.seed);
  if (agent === null) throw new Error(`tournament: unknown agent name "${a.name}"`);
  return agent;
};

/**
 * Sequential fallback. Preserves the *original* (pre-parallel) playMatch
 * semantics: agent functions are created by the caller and reused across
 * every game in the match. Internal RNG state (e.g., randomAgent's stream)
 * continues across games, matching the behavior every regression test was
 * calibrated against.
 *
 * Note: this means descriptor + sequential is NOT identical to descriptor +
 * parallel, because workers necessarily create a fresh agent per game.
 * Tests that care about exact game-for-game reproducibility should pass
 * agent functions (this path).
 */
const runSequential = async (
  agentA: AgentArg,
  agentB: AgentArg,
  opts: MatchOptions,
): Promise<MatchResult> => {
  const fnA = resolveAgent(agentA);
  const fnB = resolveAgent(agentB);
  const numPlayers = opts.numPlayers ?? 2;
  const rng = opts.rng ?? Math.random;
  const maxTurns = opts.maxTurnsPerGame ?? 400;
  const result: MatchResult = { aWins: 0, bWins: 0, draws: 0, totalTurns: 0 };

  for (let g = 0; g < opts.games; g++) {
    let s = initialState(numPlayers, { rng });
    const seatA: PlayerIndex = numPlayers === 2 ? ((g % 2) as PlayerIndex) : 0;
    let stalled = false;
    while (!isTerminal(s) && s.turnNumber < maxTurns) {
      if (legalActions(s).length === 0) {
        stalled = true;
        break;
      }
      const agent = s.currentPlayer === seatA ? fnA : fnB;
      const action = agent(s);
      s = applyTurn(s, action);
      opts.onTurn?.(s, g);
    }
    const winnerPlayer = stalled || s.turnNumber >= maxTurns ? null : winner(s);
    accumulate(result, seatA, winnerPlayer, s.turnNumber);
    opts.onGameEnd?.(s, g, winnerPlayer);
  }

  return result;
};

type WorkerResponse =
  | { ok: true; result: { gameIndex: number; winnerPlayer: number | null; stalled: boolean; turnsPlayed: number } }
  | { ok: false; gameIndex: number; error: string };

const workerUrl = (): URL =>
  new URL('./tournament-worker-bootstrap.mjs', import.meta.url);

const runParallel = (
  agentA: AgentDescriptor,
  agentB: AgentDescriptor,
  specs: GameSpec[],
  concurrency: number,
): Promise<MatchResult> => {
  const result: MatchResult = { aWins: 0, bWins: 0, draws: 0, totalTurns: 0 };
  if (specs.length === 0) return Promise.resolve(result);

  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    let nextIdx = 0;
    let completed = 0;
    let failed = false;

    const url = workerUrl();
    const dispatch = (worker: Worker): void => {
      if (failed) return;
      if (nextIdx >= specs.length) {
        void worker.terminate();
        return;
      }
      const spec = specs[nextIdx++];
      if (spec === undefined) return;
      worker.postMessage({
        gameIndex: spec.gameIndex,
        stateSeed: spec.stateSeed,
        seatA: spec.seatA,
        numPlayers: spec.numPlayers,
        maxTurnsPerGame: spec.maxTurnsPerGame,
        agentA,
        agentB,
      });
    };

    const onResponse = (worker: Worker, msg: WorkerResponse): void => {
      if (failed) return;
      if (!msg.ok) {
        failed = true;
        for (const w of workers) void w.terminate();
        reject(new Error(`tournament-worker game ${msg.gameIndex}: ${msg.error}`));
        return;
      }
      const r = msg.result;
      const spec = specs[r.gameIndex];
      if (spec === undefined) {
        failed = true;
        reject(new Error(`tournament: orphan result for game ${r.gameIndex}`));
        return;
      }
      accumulate(result, spec.seatA, r.winnerPlayer, r.turnsPlayed);
      completed += 1;
      if (completed === specs.length) {
        for (const w of workers) void w.terminate();
        resolve(result);
      } else {
        dispatch(worker);
      }
    };

    const numWorkers = Math.min(concurrency, specs.length);
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(fileURLToPath(url));
      workers.push(worker);
      worker.on('message', (msg: WorkerResponse) => onResponse(worker, msg));
      worker.on('error', (err) => {
        if (failed) return;
        failed = true;
        for (const w of workers) void w.terminate();
        reject(err);
      });
      dispatch(worker);
    }
  });
};

/**
 * Runs `games` matches between two agents. Returns a Promise so the parallel
 * path can use worker threads without changing the call site.
 *
 * Modes:
 *   - **Parallel** (when both arguments are `AgentDescriptor` and no per-turn
 *     callback is set): games are dispatched across a worker pool.
 *   - **Sequential** (when either argument is an `Agent` function, or any
 *     callback is set): games run inline on the main thread.
 *
 * Both modes pre-compute per-game seeds from `opts.rng` so the *content* of
 * each game is identical regardless of mode.
 */
export const playMatch = async (
  agentA: AgentArg,
  agentB: AgentArg,
  opts: MatchOptions,
): Promise<MatchResult> => {
  const bothDescriptors = isAgentDescriptor(agentA) && isAgentDescriptor(agentB);
  const hasCallbacks = opts.onTurn !== undefined || opts.onGameEnd !== undefined;
  if (!bothDescriptors || hasCallbacks) {
    return runSequential(agentA, agentB, opts);
  }
  const specs = buildSpecs(opts);
  const defaultConcurrency = Math.max(1, cpus().length - 1);
  const concurrency = opts.concurrency ?? defaultConcurrency;
  return runParallel(agentA as AgentDescriptor, agentB as AgentDescriptor, specs, concurrency);
};
