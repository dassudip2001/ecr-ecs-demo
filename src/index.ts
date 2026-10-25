import { app, logger } from "./app";
import { config } from "./config";

const server = app.listen(config.PORT, () =>
  logger.info(`Listening on :${config.PORT}`)
);

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    // await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // force exit if stuck
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
