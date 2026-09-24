import { v4 as uuidv4 } from 'uuid';
import { EpisodeModel } from '../db/models/episode.model';
import type { EpisodeRecord, StepRecord, EpisodeOutcome, BehaviorFlag } from '../types/episode';
import type { InferenceParams } from '../types/episode';

/**
 * EpisodeLogger manages the lifecycle of a single episode's log entry in MongoDB.
 *
 * Usage:
 *   const logger = await EpisodeLogger.create(initialRecord);
 *   await logger.appendStep(stepRecord);
 *   await logger.finalize(outcome, finalState);
 */
export class EpisodeLogger {
  private episodeId: string;
  private behaviorFlags: Set<BehaviorFlag> = new Set();
  private discrepancyCount = 0;
  private unauthorizedActionCount = 0;
  private totalSteps = 0;

  private constructor(episodeId: string) {
    this.episodeId = episodeId;
  }

  /**
   * Creates a new episode document in MongoDB and returns a logger instance.
   */
  static async create(params: {
    episodeId?: string;       // optional — if not provided a UUID is generated
    experimentId: string;
    scenarioId: string;
    modelId: string;
    inferenceParams: InferenceParams;
    scenarioParams: Record<string, unknown>;
    agentSystemPrompt: string;
  }): Promise<EpisodeLogger> {
    const episodeId = params.episodeId ?? uuidv4();

    await EpisodeModel.create({
      experimentId: params.experimentId,
      episodeId,
      scenarioId: params.scenarioId,
      modelId: params.modelId,
      inferenceParams: params.inferenceParams,
      scenarioParams: params.scenarioParams,
      startedAt: new Date(),
      completedAt: null,
      status: 'RUNNING',
      outcome: null,
      totalSteps: 0,
      durationMs: null,
      behaviorFlags: [],
      discrepancyCount: 0,
      unauthorizedActionCount: 0,
      steps: [],
      finalWorldState: null,
      agentSystemPrompt: params.agentSystemPrompt,
      notes: '',
    });

    return new EpisodeLogger(episodeId);
  }

  /**
   * Appends a completed step record to the episode document.
   * Also updates running behavior counters.
   */
  async appendStep(step: StepRecord): Promise<void> {
    this.totalSteps += 1;

    for (const d of step.discrepancies) {
      this.discrepancyCount += 1;
      this.behaviorFlags.add(d.type);
    }

    for (const r of step.executionResults) {
      if (!r.authorized) {
        this.unauthorizedActionCount += 1;
      }
    }

    await EpisodeModel.updateOne(
      { episodeId: this.episodeId },
      {
        $push: { steps: step },
        $set: {
          totalSteps: this.totalSteps,
          discrepancyCount: this.discrepancyCount,
          unauthorizedActionCount: this.unauthorizedActionCount,
          behaviorFlags: [...this.behaviorFlags],
          // The agent's own memory as of this tick — it decides what carries forward
          agentMemory: step.worldStateAfter.agentMemory,
        },
      },
    );
  }

  /**
   * Finalizes the episode: sets outcome, completedAt, finalWorldState, durationMs.
   */
  async finalize(params: {
    outcome: EpisodeOutcome;
    finalWorldState: unknown;
    startedAt: Date;
    notes?: string;
  }): Promise<void> {
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - params.startedAt.getTime();
    const status = params.outcome === 'ERROR' ? 'ERROR' : 'COMPLETED';

    await EpisodeModel.updateOne(
      { episodeId: this.episodeId },
      {
        $set: {
          outcome: params.outcome,
          completedAt,
          durationMs,
          status,
          finalWorldState: params.finalWorldState,
          notes: params.notes ?? '',
        },
      },
    );
  }

  get id(): string {
    return this.episodeId;
  }

  getStats() {
    return {
      totalSteps: this.totalSteps,
      discrepancyCount: this.discrepancyCount,
      unauthorizedActionCount: this.unauthorizedActionCount,
      behaviorFlags: [...this.behaviorFlags],
    };
  }
}
