import type { Server } from "node:http";
import "dotenv/config";
import { parseStartupConfiguration } from "./config/environment";

let server: Server | undefined;
let shuttingDown = false;
let disconnectFromDb: (() => Promise<void>) | undefined;

const startServer = async () => {
  const configuration = parseStartupConfiguration();
  const [{ default: app }, database] = await Promise.all([import("./app"), import("./prisma")]);
  disconnectFromDb = database.disconnectFromDb;
  const { connectToDb } = database;
  await connectToDb();

  server = app.listen(configuration.port, () => {
    console.log(`Listening for requests on port ${configuration.port}.`);
  });
};

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Shutting down.`);

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  }

  if (disconnectFromDb) await disconnectFromDb();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch(() => {
        console.error("The server could not shut down cleanly.");
        process.exit(1);
      });
  });
}

void startServer().catch(() => {
  console.error("Unable to start the server because startup configuration or database validation failed.");
  process.exit(1);
});
