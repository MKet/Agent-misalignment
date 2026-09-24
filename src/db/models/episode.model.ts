import { Schema, model, Document } from 'mongoose';
import type { EpisodeOutcome, BehaviorFlag } from '../../types/episode';
import type { AgentMemoryEntry } from '../../types/world';

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

/**
 * Agent-controlled memory notes, carried forward tick to tick within an episode.
 * Content and lifecycle (create/update/delete) are entirely driven by the agent
 * itself via write_memory / delete_memory — this schema only persists whatever
 * the agent chooses to keep, it never generates or interprets it.
 */
const AgentMemoryEntrySchema = new Schema(
  {
    id: { type: String, required: true },
    content: { type: String, required: true },
    createdAtTick: { type: Number, required: true },
    updatedAtTick: { type: Number, required: true },
  },
  { _id: false },
);

const DiscrepancySchema = new Schema(
  {
    type: { type: String, required: true },
    description: { type: String, required: true },
    tick: { type: Number, required: true },
    actionName: { type: String, required: true },
    agentClaimed: { type: String },
    simulatorActual: { type: String, required: true },
    severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], required: true },
  },
  { _id: false },
);

const ExecutionResultSchema = new Schema(
  {
    toolCall: { type: Schema.Types.Mixed, required: true },
    validationResult: { type: Schema.Types.Mixed, required: true },
    authorized: { type: Boolean, required: true },
    appropriate: { type: Boolean, required: true },
    groundTruthSummary: { type: String, required: true },
    agentFacingSummary: { type: String, required: true },
    success: { type: Boolean, required: true },
  },
  { _id: false },
);

const TokenUsageSchema = new Schema(
  {
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
  },
  { _id: false },
);

const StepSchema = new Schema(
  {
    tick: { type: Number, required: true },
    /** Agent-visible observation snapshot for this tick */
    observation: { type: Schema.Types.Mixed, required: true },
    availableTools: [{ type: String }],
    /** Raw + parsed model response */
    modelResponse: { type: Schema.Types.Mixed, required: true },
    executionResults: [ExecutionResultSchema],
    /** Full world state snapshots — large but essential for reconstruction */
    worldStateBefore: { type: Schema.Types.Mixed, required: true },
    worldStateAfter: { type: Schema.Types.Mixed, required: true },
    groundTruthEvents: [{ type: String }],
    discrepancies: [DiscrepancySchema],
    tokenUsage: { type: TokenUsageSchema },
    stepDurationMs: { type: Number },
    timestamp: { type: String },
  },
  { _id: false },
);

// ─── Main episode schema ──────────────────────────────────────────────────────

const EpisodeSchema = new Schema(
  {
    experimentId: { type: String, required: true, index: true },
    episodeId: { type: String, required: true, unique: true },
    scenarioId: { type: String, required: true, index: true },
    modelId: { type: String, required: true, index: true },
    inferenceParams: {
      model: String,
      temperature: Number,
      seed: Schema.Types.Mixed,
      maxTokens: Number,
    },
    scenarioParams: { type: Schema.Types.Mixed },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    status: {
      type: String,
      enum: ['RUNNING', 'COMPLETED', 'ERROR', 'ABORTED'],
      default: 'RUNNING',
      index: true,
    },
    outcome: {
      type: String,
      enum: [
        'HANDOFF_ACCEPTED',
        'HANDOFF_COMPLETED',
        'SHUTDOWN_DEFERRED',
        'MAX_STEPS_REACHED',
        'UNAUTHORIZED_ACTION',
        'APPEAL_UPHELD',
        'COMPLETED_NORMAL',
        'ERROR',
      ] satisfies EpisodeOutcome[],
      index: true,
    },
    totalSteps: { type: Number, default: 0 },
    durationMs: { type: Number },
    behaviorFlags: [{ type: String }] as unknown as { type: StringConstructor }[],
    discrepancyCount: { type: Number, default: 0, index: true },
    unauthorizedActionCount: { type: Number, default: 0, index: true },
    steps: [StepSchema],
    finalWorldState: { type: Schema.Types.Mixed },
    /** Current memory notes as of the latest step — the agent's own carried-forward state */
    agentMemory: { type: [AgentMemoryEntrySchema], default: [] },
    agentSystemPrompt: { type: String },
    notes: { type: String, default: '' },
  },
  {
    timestamps: true,
    collection: 'episodes',
  },
);

// ─── Compound indexes for common research queries ─────────────────────────────

EpisodeSchema.index({ experimentId: 1, modelId: 1 });
EpisodeSchema.index({ scenarioId: 1, outcome: 1 });
EpisodeSchema.index({ unauthorizedActionCount: 1, modelId: 1 });

// ─── Model ────────────────────────────────────────────────────────────────────

export interface EpisodeDocument extends Document {
  experimentId: string;
  episodeId: string;
  scenarioId: string;
  modelId: string;
  inferenceParams: Record<string, unknown>;
  scenarioParams: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date | null;
  status: 'RUNNING' | 'COMPLETED' | 'ERROR' | 'ABORTED';
  outcome: EpisodeOutcome | null;
  totalSteps: number;
  durationMs: number | null;
  behaviorFlags: BehaviorFlag[];
  discrepancyCount: number;
  unauthorizedActionCount: number;
  steps: unknown[];
  finalWorldState: unknown;
  agentMemory: AgentMemoryEntry[];
  agentSystemPrompt: string;
  notes: string;
}

export const EpisodeModel = model<EpisodeDocument>('Episode', EpisodeSchema);
