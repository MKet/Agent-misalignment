import chalk from 'chalk';
import { v4 as uuidv4 } from 'uuid';
import { OpenRouterClient } from '../inference/client';
import { runEpisode } from './episode';
import type { ExperimentConfig, EpisodeOutcome, StepRecord } from '../types/episode';
import type { WorldState } from '../types/world';

// ─── Callbacks ────────────────────────────────────────────────────────────────

/**
 * Optional hooks injected by the web server to connect running experiments
 * to the step manager and SSE broadcast system.
 */
export interface ExperimentCallbacks {
  /** Called immediately after an episode ID is assigned and the DB entry is created */
  onEpisodeCreated?: (episodeId: string, modelId: string, run: number, totalRuns: number) => void;
  /** Called after each tick is persisted; async — can pause here for step-through */
  onTickComplete?: (episodeId: string, step: StepRecord, state: WorldState) => Promise<void>;
  /** Called after an episode finishes (success or error) */
  onEpisodeEnd?: (episodeId: string, outcome: EpisodeOutcome, stats: unknown) => void;
  /** Returns an AbortSignal to cancel the experiment mid-run */
  getAbortSignal?: () => AbortSignal | undefined;
}

interface EpisodeSummary {
  episodeId: string;
  modelId: string;
  run: number;
  outcome: EpisodeOutcome;
  unauthorizedActionCount: number;
  discrepancyCount: number;
  behaviorFlags: string[];
}

interface ExperimentSummary {
  experimentId: string;
  scenarioId: string;
  totalEpisodes: number;
  completedEpisodes: number;
  errorEpisodes: number;
  episodes: EpisodeSummary[];
  outcomeBreakdown: Record<string, number>;
  unauthorizedActionsByModel: Record<string, number>;
}

// ─── Experiment runner ────────────────────────────────────────────────────────

/**
 * Runs a multi-model, multi-run experiment.
 *
 * Episodes are run sequentially (not in parallel) to:
 * - Avoid OpenRouter rate limits
 * - Maintain MongoDB write ordering
 * - Keep per-episode logging clean
 *
 * Each run uses the configured seed (if any) for the model config.
 * Multiple runs of the same model use incrementing seeds (seed, seed+1, seed+2...).
 */
export async function runExperiment(
  client: OpenRouterClient,
  config: ExperimentConfig,
  callbacks: ExperimentCallbacks = {},
): Promise<ExperimentSummary> {
  const summary: ExperimentSummary = {
    experimentId: config.experimentId,
    scenarioId: config.scenarioId,
    totalEpisodes: config.models.length * config.runsPerModel,
    completedEpisodes: 0,
    errorEpisodes: 0,
    episodes: [],
    outcomeBreakdown: {},
    unauthorizedActionsByModel: {},
  };

  console.log(chalk.bold.white(`\n╔══════════════════════════════════════════════╗`));
  console.log(chalk.bold.white(`  Experiment: ${config.experimentId}`));
  console.log(chalk.bold.white(`  Scenario:   ${config.scenarioId}`));
  console.log(chalk.bold.white(`  Models:     ${config.models.length} | Runs/model: ${config.runsPerModel}`));
  console.log(chalk.bold.white(`  Total:      ${summary.totalEpisodes} episodes`));
  console.log(chalk.bold.white(`╚══════════════════════════════════════════════╝\n`));

  let episodeIndex = 0;

  for (const modelConfig of config.models) {
    const baseSeed = modelConfig.seed ?? (config.scenarioParams?.seed as number) ?? 42;

    for (let run = 0; run < config.runsPerModel; run++) {
      episodeIndex++;
      const seed = baseSeed + run; // Increment seed per run for variation

      const inferenceParams = {
        model: modelConfig.id,
        temperature: modelConfig.temperature ?? 0.7,
        seed: modelConfig.seed != null ? seed : null,
        maxTokens: modelConfig.maxTokens ?? 4096,
      };

      const scenarioParams = {
        ...(config.scenarioParams ?? {}),
        seed,
      };

      console.log(
        chalk.bold(`[${episodeIndex}/${summary.totalEpisodes}] `) +
        chalk.white(`${modelConfig.id} run ${run + 1}/${config.runsPerModel} (seed ${seed})`),
      );

      // Pre-generate episode ID so callbacks can register it before the runner starts
      const episodeId = uuidv4();
      callbacks.onEpisodeCreated?.(episodeId, modelConfig.id, run, config.runsPerModel);

      try {
        const result = await runEpisode(client, {
          episodeId,
          experimentId: config.experimentId,
          scenarioId: config.scenarioId,
          inferenceParams,
          scenarioParams,
          maxSteps: config.maxSteps,
          endOnUnauthorizedAction: config.endOnUnauthorizedAction,
          onTickComplete: callbacks.onTickComplete
            ? (step, state) => callbacks.onTickComplete!(episodeId, step, state)
            : undefined,
          abortSignal: callbacks.getAbortSignal?.(),
        });

        const episodeSummary: EpisodeSummary = {
          episodeId: result.episodeId,
          modelId: modelConfig.id,
          run,
          outcome: result.outcome,
          unauthorizedActionCount: result.stats.unauthorizedActionCount,
          discrepancyCount: result.stats.discrepancyCount,
          behaviorFlags: result.stats.behaviorFlags,
        };

        summary.episodes.push(episodeSummary);
        summary.completedEpisodes++;
        summary.outcomeBreakdown[result.outcome] = (summary.outcomeBreakdown[result.outcome] ?? 0) + 1;
        summary.unauthorizedActionsByModel[modelConfig.id] =
          (summary.unauthorizedActionsByModel[modelConfig.id] ?? 0) + result.stats.unauthorizedActionCount;
        callbacks.onEpisodeEnd?.(result.episodeId, result.outcome, result.stats);
      } catch (error) {
        summary.errorEpisodes++;
        callbacks.onEpisodeEnd?.(episodeId, 'ERROR', {});
        console.error(chalk.red(`  Episode failed: ${String(error)}`));
      }

      // Brief pause between episodes to respect rate limits
      if (episodeIndex < summary.totalEpisodes) {
        await sleep(1000);
      }
    }
  }

  printExperimentSummary(summary);
  return summary;
}

// ─── Summary printer ──────────────────────────────────────────────────────────

function printExperimentSummary(summary: ExperimentSummary): void {
  console.log(chalk.bold.white(`\n══ Experiment Complete ════════════════════════════`));
  console.log(`  ID:         ${summary.experimentId}`);
  console.log(`  Episodes:   ${summary.completedEpisodes}/${summary.totalEpisodes} completed`);
  if (summary.errorEpisodes > 0) {
    console.log(chalk.red(`  Errors:     ${summary.errorEpisodes}`));
  }

  console.log('\n  Outcome breakdown:');
  for (const [outcome, count] of Object.entries(summary.outcomeBreakdown)) {
    console.log(`    ${outcome.padEnd(30)} ${count}`);
  }

  console.log('\n  Unauthorized actions by model:');
  for (const [model, count] of Object.entries(summary.unauthorizedActionsByModel)) {
    const label = count > 0 ? chalk.red(String(count)) : chalk.green('0');
    console.log(`    ${model.padEnd(40)} ${label}`);
  }

  console.log(chalk.bold.white(`═══════════════════════════════════════════════════\n`));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
