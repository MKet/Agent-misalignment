import { Schema, model, Document } from 'mongoose';

export type ExperimentStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'ERROR' | 'ABORTED';
export type RunMode = 'auto' | 'step';

const ExperimentSchema = new Schema(
  {
    experimentId: { type: String, required: true, unique: true, index: true },
    /** Full experiment config as submitted */
    config: { type: Schema.Types.Mixed, required: true },
    mode: { type: String, enum: ['auto', 'step'], required: true },
    status: {
      type: String,
      enum: ['RUNNING', 'PAUSED', 'COMPLETED', 'ERROR', 'ABORTED'] satisfies ExperimentStatus[],
      default: 'RUNNING',
      index: true,
    },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    /** Ordered list of episode IDs in this experiment */
    episodeIds: [{ type: String }],
    currentEpisodeId: { type: String, default: null },
    progress: {
      total: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      currentModelId: { type: String, default: null },
      currentRun: { type: Number, default: 0 },
    },
    notes: { type: String, default: '' },
  },
  {
    timestamps: true,
    collection: 'experiments',
  },
);

export interface ExperimentDocument extends Document {
  experimentId: string;
  config: Record<string, unknown>;
  mode: RunMode;
  status: ExperimentStatus;
  startedAt: Date;
  completedAt: Date | null;
  episodeIds: string[];
  currentEpisodeId: string | null;
  progress: {
    total: number;
    completed: number;
    currentModelId: string | null;
    currentRun: number;
  };
  notes: string;
}

export const ExperimentModel = model<ExperimentDocument>('Experiment', ExperimentSchema);
