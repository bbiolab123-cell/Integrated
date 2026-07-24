import app from "./app";
import { ensureAiTrainingSchema } from "./lib/ensureAiTrainingSchema";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./lib/seed";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start(): Promise<void> {
  await ensureAiTrainingSchema();

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    seedIfEmpty().catch((e) => logger.error({ err: e }, "Seed error"));
  });
}

start().catch((err) => {
  logger.fatal({ err }, "Database compatibility migration failed");
  process.exit(1);
});
