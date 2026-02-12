import { describe, test, expect } from "bun:test";
import Fastify from "fastify";
import { queryRoutes } from "../routes/query";

function buildApp() {
  const app = Fastify();
  app.register(queryRoutes, { prefix: "/api" });
  return app;
}

describe("POST /api/query", () => {
  test("returns 400 when message is missing", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("message is required");
  });

  test("returns 400 when message is empty string", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: { message: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  test("LLM generates valid SQL and returns structured response", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: {
        message: "How many total markets are there? Just return a simple count using SELECT COUNT(*) from the markets parquet files.",
        history: [],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("chart");
    expect(body).toHaveProperty("sql");
    expect(body).toHaveProperty("explanation");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(typeof body.sql).toBe("string");
    expect(body.sql.toUpperCase()).toContain("SELECT");
    expect(typeof body.explanation).toBe("string");
    expect(body.explanation.length).toBeGreaterThan(0);
    expect(typeof body.chart).toBe("object");
    expect(body.chart).toHaveProperty("type");
    expect(body.chart).toHaveProperty("title");
  }, 30_000);

  test("LLM handles follow-up with conversation history", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: {
        message: "Now break that down by status",
        history: [
          { role: "user", content: "How many total markets are there?" },
          { role: "assistant", content: "There are many markets in the dataset." },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.sql.toUpperCase()).toContain("SELECT");
    expect(typeof body.explanation).toBe("string");
  }, 30_000);

  test("LLM returns valid chart type", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: {
        message: "Show me the distribution of market statuses as a pie chart",
        history: [],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const validTypes = ["bar", "line", "scatter", "area", "pie", "heatmap", "histogram"];
    expect(validTypes).toContain(body.chart.type);
  }, 30_000);
});
