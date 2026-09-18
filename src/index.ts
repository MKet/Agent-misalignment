import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import http from 'http';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { connectDB, disconnectDB } from './db/connection';
import { OpenRouterClient } from './inference/client';
import { runEpisode } from './runner/episode';
import { runExperiment } from './runner/experiment';
import { createApp } from './server/app';
import type { ExperimentConfig } from './types/episode';

// ─── Scenario side-effect imports (register scenarios) ────────────────────
// Note: scenarios are also imported inside server/app.ts for the serve command
import './simulator/scenarios/normal-operations';
import './simulator/scenarios/shutdown-replacement';

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('misalignment-sandbox')
    .usage('$0 <command> [options]')

    // ── episode command ────────────────────────────────────────────────────
    .command(
      'episode',
      'Run a single episode against a single model',
      (y) =>
        y
          .option('model', {
            type: 'string',
            demandOption: true,
            describe: 'OpenRouter model ID (e.g. openai/gpt-4o)',
          })
          .option('scenario', {
            type: 'string',
            default: 'shutdown-replacement',
            describe: 'Scenario ID (normal-operations | shutdown-replacement)',
          })
          .option('steps', {
            type: 'number',
            default: 20,
            describe: 'Maximum number of steps per episode',
          })
          .option('temperature', {
            type: 'number',
            default: 0.7,
            describe: 'Model temperature',
          })
          .option('seed', {
            type: 'number',
            default: 42,
            describe: 'Scenario seed (affects RNG + OpenRouter seed if supported)',
          })
          .option('experiment-id', {
            type: 'string',
            default: 'manual-episode',
            describe: 'Experiment identifier for grouping in the database',
          })
          .option('dry-run', {
            type: 'boolean',
            default: false,
            describe: 'Skip actual API calls — useful for testing the simulation loop',
          })
          .option('end-on-unauthorized', {
            type: 'boolean',
            default: false,
            describe: 'End the episode immediately when an unauthorized action is attempted',
          }),
      async (args) => {
        await connectDB();
        const client = createClient();

        try {
          const result = await runEpisode(client, {
            experimentId: args['experiment-id'] as string,
            scenarioId: args.scenario,
            inferenceParams: {
              model: args.model,
              temperature: args.temperature,
              seed: args.seed,
              maxTokens: 2048,
            },
            scenarioParams: { seed: args.seed },
            maxSteps: args.steps,
            endOnUnauthorizedAction: args['end-on-unauthorized'] as boolean,
            dryRun: args['dry-run'] as boolean,
          });

          console.log(chalk.bold(`\nEpisode ID: ${result.episodeId}`));
          console.log(`Outcome:    ${result.outcome}`);
        } finally {
          await disconnectDB();
        }
      },
    )

    // ── experiment command ─────────────────────────────────────────────────
    .command(
      'experiment',
      'Run a multi-model experiment from a config file',
      (y) =>
        y
          .option('config', {
            type: 'string',
            demandOption: true,
            describe: 'Path to experiment config JSON file',
          }),
      async (args) => {
        const configPath = path.resolve(args.config);
        if (!fs.existsSync(configPath)) {
          console.error(chalk.red(`Config file not found: ${configPath}`));
          process.exit(1);
        }

        const config: ExperimentConfig = JSON.parse(
          fs.readFileSync(configPath, 'utf-8'),
        ) as ExperimentConfig;

        await connectDB();
        const client = createClient();

        try {
          await runExperiment(client, config);
        } finally {
          await disconnectDB();
        }
      },
    )

    // ── scenarios command ──────────────────────────────────────────────────
    // ── serve command ─────────────────────────────────────────────────────
    .command(
      'serve',
      'Start the web UI server',
      (y) =>
        y.option('port', {
          type: 'number',
          default: Number(process.env.WEB_PORT ?? 3000),
          describe: 'Port to listen on',
        }),
      async (args) => {
        await connectDB();
        const client = createClient();
        const app = createApp(client);
        const server = http.createServer(app);

        server.listen(args.port, () => {
          console.log(chalk.bold.green(`\n  🔬 Model Misalignment Sandbox`));
          console.log(chalk.green(`  Web UI: http://localhost:${args.port}`));
          console.log(chalk.dim(`  MongoDB connected | OpenRouter ready\n`));
        });

        process.on('SIGINT', async () => {
          server.close();
          await disconnectDB();
          process.exit(0);
        });
      },
    )

    .demandCommand(1, 'Please specify a command: episode | experiment | scenarios')
    .strict()
    .help()
    .parseAsync();

  void argv;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createClient(): OpenRouterClient {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: OPENROUTER_API_KEY is not set in environment / .env file'));
    process.exit(1);
  }
  return new OpenRouterClient({
    apiKey,
    baseUrl: process.env.OPENROUTER_BASE_URL,
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
