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
      logger.error(
        { err, port, exitCode: 1, retryExpected: false },
        "The API server could not bind its listening port, so it is not serving traffic. Verify that PORT is permitted and not already in use, then restart the process.",
      );
      process.exit(1);
    }

    logger.info(
      { port, environment: process.env.NODE_ENV ?? "development" },
      "The API server is accepting connections after configuration and database compatibility checks completed; no operator action is required.",
    );
    seedIfEmpty().catch((err) => logger.error(
      { err, database: "primary", retryExpected: true },
      "The optional initial experiment seed task terminated unexpectedly after the server started; API traffic remains available. Check database connectivity and permissions, then rerun the seed if demo data is required.",
    ));
  });
}

start().catch((err) => {
  logger.fatal(
    { err, database: "primary", exitCode: 1, retryExpected: false },
    "API startup stopped because the database compatibility schema could not be ensured, so no traffic is being served. Verify DATABASE_URL, connectivity, schema permissions, and the migration error before restarting.",
  );
  process.exit(1);
});
