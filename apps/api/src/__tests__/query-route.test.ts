import { describe, test, expect } from "bun:test";
import Fastify from "fastify";
import { queryRoutes } from "../routes/query";
import { SYSTEM_PROMPT_VERSION } from "../lib/system-prompt";
import { setCachedLLM, setCachedQuery } from "../services/cache";

const QUERY_MAX_ROWS = Math.max(1, Math.floor(Number(process.env.QUERY_MAX_ROWS || "2000")));

function buildApp() {
  const app = Fastify();
  app.register(queryRoutes, { prefix: "/api" });
  return app;
}

function buildSafeExecutionSQL(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  return `SELECT * FROM (${trimmed}) AS p0_query LIMIT ${QUERY_MAX_ROWS}`;
}

function seedCachedQueryResult(input: {
  message: string;
  history?: Array<{ role: string; content: string }>;
  llm: {
    sql: string;
    chart: Record<string, unknown>;
    explanation: string;
    updateWidgetId?: string;
  };
  data?: Record<string, unknown>[];
}) {
  const history = input.history ?? [];
  const cacheKey = JSON.stringify({
    message: input.message,
    history,
    promptVersion: SYSTEM_PROMPT_VERSION,
  });

  setCachedLLM(cacheKey, input.llm as unknown as Record<string, unknown>);

  if (input.llm.sql.trim() !== "") {
    const safeSql = buildSafeExecutionSQL(input.llm.sql);
    setCachedQuery(safeSql, input.data ?? []);
  }
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

  test("returns structured response from cache", async () => {
    const message = "How many total markets are there?";
    seedCachedQueryResult({
      message,
      history: [],
      llm: {
        sql: "SELECT count() AS total_markets FROM kalshi_markets",
        chart: {
          type: "table",
          x: "total_markets",
          y: "total_markets",
          title: "Total Markets",
          xLabel: "Metric",
          yLabel: "Value",
        },
        explanation: "Counts all Kalshi markets.",
      },
      data: [{ total_markets: 123 }],
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: {
        message,
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
    expect(body.data.length).toBe(1);
    expect(body.data[0].total_markets).toBe(123);
    expect(typeof body.sql).toBe("string");
    expect(body.sql.toUpperCase()).toContain("SELECT");
    expect(typeof body.explanation).toBe("string");
    expect(body.explanation.length).toBeGreaterThan(0);
    expect(typeof body.chart).toBe("object");
    expect(body.chart).toHaveProperty("type");
    expect(body.chart).toHaveProperty("title");
  }, 30_000);

  test("handles follow-up with conversation history from cache", async () => {
    const message = "Now break that down by status";
    const history = [
      { role: "user", content: "How many total markets are there?" },
      { role: "assistant", content: "There are many markets in the dataset." },
    ];

    seedCachedQueryResult({
      message,
      history,
      llm: {
        sql: "SELECT status, count() AS market_count FROM kalshi_markets GROUP BY status ORDER BY market_count DESC",
        chart: {
          type: "bar",
          x: "status",
          y: "market_count",
          title: "Markets by Status",
          xLabel: "Status",
          yLabel: "Market Count",
        },
        explanation: "Breaks down market count by status.",
      },
      data: [{ status: "open", market_count: 42 }],
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: {
        message,
        history,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.sql.toUpperCase()).toContain("SELECT");
    expect(typeof body.explanation).toBe("string");
  }, 30_000);

  test("returns valid chart type from cache", async () => {
    const message = "Show me the distribution of market statuses as a pie chart";
    seedCachedQueryResult({
      message,
      history: [],
      llm: {
        sql: "SELECT status, count() AS market_count FROM kalshi_markets GROUP BY status",
        chart: {
          type: "pie",
          x: "status",
          y: "market_count",
          title: "Market Status Distribution",
          xLabel: "Status",
          yLabel: "Count",
        },
        explanation: "Shows status distribution.",
      },
      data: [{ status: "open", market_count: 1 }],
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/query",
      payload: {
        message,
        history: [],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const validTypes = ["bar", "line", "scatter", "area", "pie", "heatmap", "histogram"];
    expect(validTypes).toContain(body.chart.type);
  }, 30_000);
});
