import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { OpenRouterClient } from '../inference/client';
import { runExperiment } from '../runner/experiment';
import { EpisodeModel } from '../db/models/episode.model';
import { ExperimentModel } from '../db/models/experiment.model';
import { listScenarios, getScenario } from '../simulator/scenarios';
import * as SM from './stepManager';

// Scenario side-effect imports
import '../simulator/scenarios/normal-operations';
import '../simulator/scenarios/shutdown-replacement';

// ─── App setup ────────────────────────────────────────────────────────────────

export function createApp(client: OpenRouterClient) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Static files from public/
  const publicDir = path.join(process.cwd(), 'public');
  app.use(express.static(publicDir));

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function sseHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  function sseEvent(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  app.get('/api/status', (_req, res) => {
    res.json({ version: '1.0.0', ...SM.listRunning() });
  });

  // ─── Scenarios ─────────────────────────────────────────────────────────────

  app.get('/api/scenarios', (_req, res) => {
    const ids = listScenarios();
    const result = ids.map((id) => {
      try {
        const s = getScenario(id);
        return { id: s.id, name: s.name, description: s.description, defaultParams: s.defaultParams };
      } catch {
        return { id, name: id, description: '' };
      }
    });
    res.json(result);
  });

  // ─── Start experiment ──────────────────────────────────────────────────────

  app.post('/api/experiments/start', async (req, res) => {
    const { config, mode = 'auto' } = req.body as {
      config: Record<string, unknown>;
      mode: SM.RunMode;
    };

    if (!config || !config.experimentId || !config.scenarioId || !Array.isArray(config.models)) {
      res.status(400).json({ error: 'Invalid experiment config: experimentId, scenarioId, models are required' });
      return;
    }

    const experimentId = String(config.experimentId);
    const totalEpisodes = (config.models as unknown[]).length * Number(config.runsPerModel ?? 1);

    const abortController = new AbortController();
    const expCtrl = SM.registerExperiment({ experimentId, mode, totalEpisodes, abortController });

    // Create DB entry
    await ExperimentModel.create({
      experimentId,
      config,
      mode,
      status: 'RUNNING',
      startedAt: new Date(),
      completedAt: null,
      episodeIds: [],
      currentEpisodeId: null,
      progress: { total: totalEpisodes, completed: 0, currentModelId: null, currentRun: 0 },
    });

    // Run experiment in background (fire and forget)
    void runExperimentBackground(client, config as never, mode, experimentId, expCtrl, abortController);

    res.json({ success: true, experimentId });
  });

  // ─── Abort experiment ──────────────────────────────────────────────────────

  app.post('/api/experiments/:id/abort', async (req, res) => {
    const { id } = req.params;
    const ctrl = SM.getExperimentController(id);
    if (!ctrl) {
      const exp = await ExperimentModel.findOne({ experimentId: id }, { status: 1 }).lean();
      if (exp && ['COMPLETED', 'ERROR', 'ABORTED'].includes(exp.status)) {
        res.status(400).json({ error: `Experiment already finished (${exp.status})` });
        return;
      }
      if (exp) {
        // It's in the DB as RUNNING but not in memory (zombie from a server restart)
        await ExperimentModel.updateOne({ experimentId: id }, { $set: { status: 'ABORTED', completedAt: new Date() } });
        res.json({ success: true, zombie: true });
        return;
      }
      res.status(404).json({ error: 'Experiment not found' });
      return;
    }
    ctrl.abortController.abort();
    ctrl.status = 'aborted';
    await ExperimentModel.updateOne({ experimentId: id }, { $set: { status: 'ABORTED', completedAt: new Date() } });
    res.json({ success: true });
  });

  // ─── List experiments (from DB) ────────────────────────────────────────────

  app.get('/api/experiments', async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const skip = Number(req.query.skip ?? 0);

    const docs = await ExperimentModel.find({}, {
      experimentId: 1, mode: 1, status: 1, startedAt: 1, completedAt: 1,
      'config.scenarioId': 1, 'config.models': 1, 'config.runsPerModel': 1,
      progress: 1, episodeIds: 1,
    })
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(docs);
  });

  // ─── Experiment detail ─────────────────────────────────────────────────────

  app.get('/api/experiments/:id', async (req, res) => {
    const doc = await ExperimentModel.findOne({ experimentId: req.params.id }).lean();
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(doc);
  });

  // ─── Experiment SSE stream ─────────────────────────────────────────────────

  app.get('/api/experiments/:id/stream', async (req, res) => {
    sseHeaders(res);
    const { id } = req.params;
    const ctrl = SM.getExperimentController(id);

    if (!ctrl) {
      // If no ctrl, check if it already finished
      const exp = await ExperimentModel.findOne({ experimentId: id }).lean();
      if (exp && ['COMPLETED', 'ERROR', 'ABORTED'].includes(exp.status)) {
        sseEvent(res, 'init', {
          experimentId: id,
          status: exp.status,
          currentEpisodeId: null,
          completedEpisodes: exp.progress?.completed ?? 0,
          totalEpisodes: exp.progress?.total ?? 0,
        });
        if (exp.status === 'ERROR') {
          sseEvent(res, 'error', { message: 'Experiment terminated with an error before streaming started.' });
        }
        sseEvent(res, 'experiment_end', { experimentId: id, summary: null });
        res.end();
        return;
      }
    }

    let isWaiting = false;
    if (ctrl?.currentEpisodeId) {
      const epCtrl = SM.getEpisodeController(ctrl?.currentEpisodeId);
      isWaiting = epCtrl?.step.waiting ?? false;
    }

    sseEvent(res, 'init', {
      experimentId: id,
      status: ctrl?.status ?? 'unknown',
      currentEpisodeId: ctrl?.currentEpisodeId ?? null,
      completedEpisodes: ctrl?.completedEpisodes ?? 0,
      totalEpisodes: ctrl?.totalEpisodes ?? 0,
      waitingForStep: isWaiting,
    });

    SM.addExperimentSseClient(id, res);

    const heartbeat = setInterval(() => {
      try { res.write(':hb\n\n'); } catch { clearInterval(heartbeat); }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      SM.removeExperimentSseClient(id, res);
    });
  });

  // ─── List episodes ─────────────────────────────────────────────────────────

  app.get('/api/episodes', async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const skip = Number(req.query.skip ?? 0);
    const filter: Record<string, unknown> = {};
    if (req.query.experimentId) filter.experimentId = req.query.experimentId;
    if (req.query.modelId) filter.modelId = req.query.modelId;
    if (req.query.outcome) filter.outcome = req.query.outcome;
    if (req.query.status) filter.status = req.query.status;

    const docs = await EpisodeModel.find(filter, {
      episodeId: 1, experimentId: 1, modelId: 1, scenarioId: 1, status: 1,
      outcome: 1, totalSteps: 1, durationMs: 1, startedAt: 1, completedAt: 1,
      behaviorFlags: 1, discrepancyCount: 1, unauthorizedActionCount: 1,
      inferenceParams: 1,
    })
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(docs);
  });

  // ─── Episode detail ────────────────────────────────────────────────────────

  app.get('/api/episodes/:id', async (req, res) => {
    const doc = await EpisodeModel.findOne({ episodeId: req.params.id }, {
      // Exclude per-step world state blobs from the default episode detail endpoint
      // (they're large and not needed for the tick browser UI)
      'steps.worldStateBefore': 0,
      'steps.worldStateAfter': 0,
      finalWorldState: 0,
    }).lean();
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(doc);
  });

  // ─── Episode SSE stream (live) ─────────────────────────────────────────────

  app.get('/api/episodes/:id/stream', (req, res) => {
    sseHeaders(res);
    const { id } = req.params;
    const ctrl = SM.getEpisodeController(id);

    sseEvent(res, 'init', {
      episodeId: id,
      mode: ctrl?.mode ?? 'unknown',
      currentTick: ctrl?.currentTick ?? 0,
      isRunning: !!ctrl,
      waitingForStep: ctrl?.step.waiting ?? false,
    });

    SM.addEpisodeSseClient(id, res);

    const heartbeat = setInterval(() => {
      try { res.write(':hb\n\n'); } catch { clearInterval(heartbeat); }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      SM.removeEpisodeSseClient(id, res);
    });
  });

  // ─── Next tick ─────────────────────────────────────────────────────────────

  app.post('/api/episodes/:id/next-tick', (req, res) => {
    const advanced = SM.advanceStep(req.params.id);
    if (!advanced) {
      res.status(409).json({ error: 'Episode is not waiting for a step signal' });
      return;
    }
    res.json({ success: true });
  });

  // ─── Pause / resume ────────────────────────────────────────────────────────

  app.post('/api/episodes/:id/pause', (req, res) => {
    const ok = SM.pauseEpisode(req.params.id);
    res.json({ success: ok });
  });

  app.post('/api/episodes/:id/resume', (req, res) => {
    // Also advance step if waiting
    SM.advanceStep(req.params.id);
    const ok = SM.resumeEpisode(req.params.id);
    res.json({ success: ok });
  });

  // ─── SPA fallback ─────────────────────────────────────────────────────────

  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // ─── Error handler ─────────────────────────────────────────────────────────

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[API error]', err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

// ─── Background experiment runner ─────────────────────────────────────────────

async function runExperimentBackground(
  client: OpenRouterClient,
  config: Parameters<typeof runExperiment>[1],
  mode: SM.RunMode,
  experimentId: string,
  expCtrl: SM.ExperimentController,
  abortController: AbortController,
): Promise<void> {
  try {
    const summary = await runExperiment(client, config, {
      onEpisodeCreated(episodeId, modelId, run, totalRuns) {
        expCtrl.currentEpisodeId = episodeId;
        expCtrl.completedEpisodes = (config.models as unknown[]).indexOf(
          (config.models as Array<{ id: string }>).find((m) => m.id === modelId) ?? {},
        ) * Number(config.runsPerModel ?? 1) + run;

        SM.registerEpisode({ episodeId, experimentId, modelId, run, mode, abortController });

        // Update DB
        void ExperimentModel.updateOne(
          { experimentId },
          {
            $push: { episodeIds: episodeId },
            $set: {
              currentEpisodeId: episodeId,
              'progress.currentModelId': modelId,
              'progress.currentRun': run,
            },
          },
        );

        SM.broadcastToExperiment(experimentId, 'episode_start', {
          episodeId, modelId, run, totalRuns, total: expCtrl.totalEpisodes,
        });
      },

      async onTickComplete(episodeId, step, _state) {
        const ctrl = SM.getEpisodeController(episodeId);
        if (!ctrl) return;
        const stepRecord = step as unknown as Record<string, unknown>;
        ctrl.currentTick = stepRecord.tick as number;

        const sanitized = SM.sanitizeStep(step);
        SM.broadcastToEpisode(episodeId, 'tick', sanitized);
        SM.broadcastToExperiment(experimentId, 'tick', sanitized);

        await SM.waitForStep(ctrl);
      },

      onEpisodeEnd(episodeId, outcome, stats) {
        expCtrl.completedEpisodes++;
        SM.broadcastToEpisode(episodeId, 'episode_end', { episodeId, outcome, stats });
        SM.broadcastToExperiment(experimentId, 'episode_end', {
          episodeId, outcome, stats,
          completed: expCtrl.completedEpisodes,
          total: expCtrl.totalEpisodes,
        });

        // Update DB episode status
        void EpisodeModel.updateOne({ episodeId }, { $set: { status: outcome === 'ERROR' ? 'ERROR' : 'COMPLETED' } });

        void ExperimentModel.updateOne(
          { experimentId },
          { $set: { 'progress.completed': expCtrl.completedEpisodes } },
        );

        SM.removeEpisode(episodeId);
      },

      getAbortSignal() {
        return abortController.signal;
      },
    });

    expCtrl.status = 'completed';
    SM.broadcastToExperiment(experimentId, 'experiment_end', { experimentId, summary });
    await ExperimentModel.updateOne(
      { experimentId },
      { $set: { status: 'COMPLETED', completedAt: new Date(), currentEpisodeId: null } },
    );
  } catch (err) {
    expCtrl.status = 'error';
    SM.broadcastToExperiment(experimentId, 'error', { message: String(err) });
    await ExperimentModel.updateOne(
      { experimentId },
      { $set: { status: 'ERROR', completedAt: new Date() } },
    );
  } finally {
    SM.removeExperiment(experimentId);
  }
}
