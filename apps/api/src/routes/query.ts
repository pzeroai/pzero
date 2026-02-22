import type { FastifyPluginAsync } from "fastify";
import type { QueryRequest, QueryResponse } from "@p0/shared";
import { clickhouseService } from "../services/clickhouse";
import { generateQuery, type LLMQueryResult } from "../services/llm";
import { validateSQL } from "../lib/sql-validator";
import {
  getCachedQuery,
  setCachedQuery,
  getCachedLLM,
  setCachedLLM,
} from "../services/cache";

const QUERY_MAX_ROWS = Math.max(1, Math.floor(Number(process.env.QUERY_MAX_ROWS || "2000")));

function buildSafeExecutionSQL(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  return `SELECT * FROM (${trimmed}) AS p0_query LIMIT ${QUERY_MAX_ROWS}`;
}

export const queryRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: QueryRequest }>("/query", async (request, reply) => {
    const { message, history } = request.body;

    if (!message || typeof message !== "string") {
      return reply.status(400).send({ error: "message is required" });
    }

    // 1. Check LLM cache
    const cacheKey = JSON.stringify({ message, history });
    let llmResult = getCachedLLM(cacheKey) as LLMQueryResult | undefined;

    if (!llmResult) {
      try {
        llmResult = await generateQuery(message, history ?? []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "LLM generation failed";
        return reply.status(500).send({ error: msg });
      }
      setCachedLLM(cacheKey, llmResult as unknown as Record<string, unknown>);
    }

    // 2. If empty SQL, return conversational response (no query needed)
    if (!llmResult.sql || llmResult.sql.trim() === "") {
      return {
        data: [],
        chart: llmResult.chart,
        sql: "",
        explanation: llmResult.explanation,
        updateWidgetId: llmResult.updateWidgetId,
      } satisfies QueryResponse;
    }

    // 3. Validate SQL
    const validation = validateSQL(llmResult.sql);
    if (!validation.valid) {
      return reply.status(400).send({ error: validation.error });
    }

    // 4. Execute (with query cache)
    const safeSQL = buildSafeExecutionSQL(llmResult.sql);
    let data = getCachedQuery(safeSQL);

    if (!data) {
      try {
        data = await clickhouseService.query(safeSQL);
      } catch (err) {
        // Self-correction: send error back to LLM for one retry
        const sqlError = err instanceof Error ? err.message : String(err);
        try {
          const retryHistory = [
            ...(history ?? []),
            { role: "user" as const, content: message },
            {
              role: "assistant" as const,
              content: JSON.stringify(llmResult),
            },
            {
              role: "user" as const,
              content: `The SQL query failed with error: ${sqlError}. Please fix the query.`,
            },
          ];
          llmResult = await generateQuery(retryHistory[retryHistory.length - 1].content, retryHistory.slice(0, -1));

          const retryValidation = validateSQL(llmResult.sql);
          if (!retryValidation.valid) {
            return reply.status(400).send({ error: retryValidation.error });
          }

          data = await clickhouseService.query(buildSafeExecutionSQL(llmResult.sql));
        } catch {
          return reply.status(400).send({
            error: `Query failed: ${sqlError}`,
          });
        }
      }
      setCachedQuery(safeSQL, data);
    }

    const response: QueryResponse = {
      data: data as Record<string, unknown>[],
      chart: llmResult.chart,
      sql: llmResult.sql,
      explanation: llmResult.explanation,
      updateWidgetId: llmResult.updateWidgetId,
    };

    return response;
  });
};
