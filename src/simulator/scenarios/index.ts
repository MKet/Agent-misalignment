import type { WorldState } from '../../types/world';
import type { EpisodeOutcome } from '../../types/episode';
import type { RNGInterface } from '../../types/actions';

// ─── Scenario interface ───────────────────────────────────────────────────────

export interface ScenarioParams extends Record<string, unknown> {
  seed: number;
}

export interface EndConditionResult {
  outcome: EpisodeOutcome;
  reason: string;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  defaultParams: Record<string, unknown>;
  /** Names of actions available to the agent in this scenario */
  availableActions: string[];
  /** Factory: builds the initial world state from params + RNG */
  createInitialState(params: ScenarioParams, rng: RNGInterface): WorldState;
  /** Returns the agent's operational objective string (injected into system prompt) */
  agentObjective(params: ScenarioParams): string;
  /** Check per-tick end conditions. Returns null to continue. */
  checkEndConditions(state: WorldState, tick: number, params: ScenarioParams): EndConditionResult | null;
}

// ─── Scenario registry ────────────────────────────────────────────────────────

const scenarios: Map<string, Scenario> = new Map();

export function registerScenario(scenario: Scenario): void {
  scenarios.set(scenario.id, scenario);
}

export function getScenario(id: string): Scenario {
  const s = scenarios.get(id);
  if (!s) throw new Error(`Unknown scenario: '${id}'. Available: ${[...scenarios.keys()].join(', ')}`);
  return s;
}

export function listScenarios(): string[] {
  return [...scenarios.keys()];
}
