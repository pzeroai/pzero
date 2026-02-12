import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { queryRoutes } from "./routes/query";
import { createMaterializedViews } from "./services/materialized-views";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(rateLimit, {
  max: 30,
  timeWindow: "1 minute",
});
await app.register(queryRoutes, { prefix: "/api" });

// Health check
app.get("/health", async () => ({ status: "ok" }));

// Start server
const start = async () => {
  try {
    // Try to create materialized views (will fail gracefully if no data)
    try {
      await createMaterializedViews();
    } catch (err) {
      console.warn("Skipping materialized views (data may not be available yet):", (err as Error).message);
    }

    await app.listen({ port: 3001, host: "0.0.0.0" });
    console.log("API server running on http://localhost:3001");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
