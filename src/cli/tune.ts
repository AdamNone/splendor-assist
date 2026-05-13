/**
 * Coordinate-descent tuner for evaluator weights, per player count.
 *
 * Walks each weight dimension trying a few multipliers, keeps whichever
 * value gave the best win advantage against a baseline (v8 by default).
 * Uses the parallel `playMatch` infrastructure — candidates are encoded
 * as `tunable:w1,w2,...` descriptors that worker threads can rebuild
 * from a string, so each tournament saturates all CPU cores.
 *
 * Usage:
 *   npm run tune -- <numPlayers> <gamesPerEval> <passes> [seed]
 *
 * Defaults: numPlayers=2, gamesPerEval=80, passes=2, seed=1.
 *
 * Output: best weight vector + each pass's improvements. Copy the vector
 * into the per-player-count weight tables in evaluate.ts.
 */
import { seededRng } from '../game/setup';
import { playMatch } from '../game/tournament';
import { TUNABLE_FEATURES } from '../game/evaluate';

const MULTIPLIERS = [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0];

const encodeWeights = (weights: readonly number[]): string =>
  `tunable:${weights.map((w) => w.toFixed(4)).join(',')}`;

const runMatch = async (
  numPlayers: 2 | 3 | 4,
  games: number,
  weights: readonly number[],
  baselineWeights: readonly number[],
  seed: number,
): Promise<{ advantage: number; aWins: number; bWins: number; draws: number }> => {
  // CRITICAL: average across multiple distinct deck-shuffle seeds within
  // each evaluation. Without this, every candidate plays the SAME 200
  // games and the tuner overfits to those specific game outcomes — the
  // first version of v9 lost 32pp out-of-sample. Splitting the games
  // budget into 4 seed blocks gives each candidate a different sample.
  const SEED_BLOCKS = 4;
  const gamesPerBlock = Math.max(1, Math.floor(games / SEED_BLOCKS));
  let aWins = 0, bWins = 0, draws = 0;
  for (let b = 0; b < SEED_BLOCKS; b++) {
    const blockSeed = seed + b * 7919; // arbitrary stride to decorrelate
    const result = await playMatch(
      { name: encodeWeights(weights), seed: blockSeed + 1001 },
      { name: encodeWeights(baselineWeights), seed: blockSeed + 2002 },
      { games: gamesPerBlock, rng: seededRng(blockSeed), numPlayers },
    );
    aWins += result.aWins;
    bWins += result.bWins;
    draws += result.draws;
  }
  return { advantage: aWins - bWins, aWins, bWins, draws };
};

const coordinateDescent = async (
  numPlayers: 2 | 3 | 4,
  gamesPerEval: number,
  passes: number,
  seed: number,
): Promise<readonly number[]> => {
  const baseline = TUNABLE_FEATURES.map((f) => f.v8);
  let weights = TUNABLE_FEATURES.map((f) => f.v8);
  let bestScore = await runMatch(numPlayers, gamesPerEval, weights, baseline, seed);
  console.log(
    `Start  vs v8: ${bestScore.aWins}-${bestScore.bWins}-${bestScore.draws} (adv ${bestScore.advantage})\n`,
  );

  for (let pass = 0; pass < passes; pass++) {
    console.log(`--- Pass ${pass + 1}/${passes} ---`);
    let changed = false;
    for (let i = 0; i < TUNABLE_FEATURES.length; i++) {
      const featureName = TUNABLE_FEATURES[i]!.name;
      let bestForDim = weights[i]!;
      let bestForDimAdv = bestScore.advantage;
      let bestForDimResult = bestScore;
      for (const mult of MULTIPLIERS) {
        const candidateValue = mult === 0 ? 0 : weights[i]! * mult;
        if (candidateValue === weights[i]) continue;
        const candidate = weights.slice();
        candidate[i] = candidateValue;
        const r = await runMatch(numPlayers, gamesPerEval, candidate, baseline, seed);
        if (r.advantage > bestForDimAdv) {
          bestForDimAdv = r.advantage;
          bestForDim = candidateValue;
          bestForDimResult = r;
        }
      }
      if (bestForDim !== weights[i]) {
        console.log(
          `  ${featureName.padEnd(32)} ${weights[i]!.toFixed(3)} → ${bestForDim.toFixed(3)} (adv ${bestForDimAdv}, ${bestForDimResult.aWins}-${bestForDimResult.bWins}-${bestForDimResult.draws})`,
        );
        weights[i] = bestForDim;
        bestScore = bestForDimResult;
        changed = true;
      } else {
        console.log(`  ${featureName.padEnd(32)} kept ${weights[i]!.toFixed(3)}`);
      }
    }
    if (!changed) {
      console.log(`Converged after ${pass + 1} pass(es).`);
      break;
    }
  }

  return weights;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const numPlayers = (parseInt(args[0] ?? '2', 10) || 2) as 2 | 3 | 4;
  const gamesPerEval = parseInt(args[1] ?? '80', 10) || 80;
  const passes = parseInt(args[2] ?? '2', 10) || 2;
  const startSeed = parseInt(args[3] ?? '1', 10) || 1;

  console.log(
    `Tuner: ${numPlayers}P | ${gamesPerEval} games/eval | ${passes} pass(es) | seed=${startSeed}\n`,
  );
  console.log(`Features in order: ${TUNABLE_FEATURES.map((f) => f.name).join(', ')}\n`);

  const t0 = Date.now();
  const weights = await coordinateDescent(numPlayers, gamesPerEval, passes, startSeed);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== Best weights for ${numPlayers}P ===`);
  TUNABLE_FEATURES.forEach((f, i) => {
    console.log(`  ${f.name.padEnd(32)} ${weights[i]?.toFixed(3)}`);
  });
  console.log(`\nElapsed: ${elapsed}s`);
};

void main();
