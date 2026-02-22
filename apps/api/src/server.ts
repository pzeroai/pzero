import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { queryRoutes } from "./routes/query";
import { createMaterializedViews } from "./services/materialized-views";

const app = Fastify({ logger: true });
const MV_BUILD_MODE = (process.env.API_MV_BUILD_MODE || "async").toLowerCase();

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
    const buildViews = async () => {
      try {
        await createMaterializedViews();
      } catch (err) {
        console.warn("Skipping materialized views (data may not be available yet):", (err as Error).message);
      }
    };

    if (MV_BUILD_MODE === "sync") {
      await buildViews();
    }

    await app.listen({ port: 3001, host: "0.0.0.0" });
    console.log("API server running on http://localhost:3001");

    if (MV_BUILD_MODE === "off") {
      console.log("Materialized view build disabled (API_MV_BUILD_MODE=off).");
      return;
    }

    if (MV_BUILD_MODE !== "sync") {
      // Default mode: do not block API startup while views are recreated.
      void buildViews();
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
