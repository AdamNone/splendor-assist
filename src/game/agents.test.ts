import { describe, expect, it } from 'vitest';
import { greedyAgent, randomAgent } from './agents';
import { applyTurn } from './apply';
import { card, makeState, player } from './fixtures';
import { seededRng } from './setup';

const emptyGems = () => ({ white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 });

describe('randomAgent', () => {
  it('picks a legal action', () => {
    const s = makeState({ gemSupply: { white: 4 } });
    const choice = randomAgent(seededRng(1))(s);
    expect(['take2', 'take3']).toContain(choice.type);
  });

  it('is deterministic given the same seed', () => {
    const s = makeState({
      gemSupply: { white: 1, blue: 1, green: 1, red: 1, black: 1 },
    });
    const a1 = randomAgent(seededRng(99))(s);
    const a2 = randomAgent(seededRng(99))(s);
    expect(a1).toEqual(a2);
  });
});

describe('greedyAgent with the baseline evaluator', () => {
  it('prefers buying a card over taking gems when both are legal', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    const choice = greedyAgent()(s);
    expect(choice.type).toBe('buy');
  });

  it('after buying, the active player gains prestige and a bonus', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s0 = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
    });
    const choice = greedyAgent()(s0);
    const s1 = applyTurn(s0, choice);
    expect(s1.players[0]?.prestige).toBe(1);
    expect(s1.players[0]?.bonuses.red).toBe(1);
  });

  it('is deterministic — same state always yields same action', () => {
    const target = card('T1-001', 1, 'red', 1, { blue: 1 });
    const s = makeState({
      faceUp: { 1: [target, null, null, null] },
      players: [player({ gems: { ...emptyGems(), blue: 1 } }), player()],
      gemSupply: { white: 4, blue: 4, green: 4 },
    });
    const agent = greedyAgent();
    expect(agent(s)).toEqual(agent(s));
  });
});
