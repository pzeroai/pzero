import type { FastifyPluginAsync } from "fastify";
import type { QueryRequest, QueryResponse } from "@p0/shared";
import { clickhouseService } from "../services/clickhouse";
import { SYSTEM_PROMPT_VERSION } from "../lib/system-prompt";
import { classifyQueryExecutionError } from "../lib/query-error-classifier";
import { enforceSqlGuardrails } from "../lib/sql-guardrails";
import {
  generateQuery,
  rewriteQueryAfterExecutionError,
  type LLMQueryResult,
} from "../services/llm";
import { validateSQL } from "../lib/sql-validator";
import {
  getCachedQuery,
  setCachedQuery,
  getCachedLLM,
  setCachedLLM,
} from "../services/cache";

const QUERY_MAX_ROWS = Math.max(1, Math.floor(Number(process.env.QUERY_MAX_ROWS || "2000")));
const QUERY_EXECUTION_REWRITE_ATTEMPTS = Math.max(
  0,
  Math.floor(Number(process.env.QUERY_EXECUTION_REWRITE_ATTEMPTS || "2")),
);
const QUERY_TRANSPORT_RETRY_ATTEMPTS = Math.max(
  0,
  Math.floor(Number(process.env.QUERY_TRANSPORT_RETRY_ATTEMPTS || "2")),
);

function buildSafeExecutionSQL(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  return `SELECT * FROM (${trimmed}) AS p0_query LIMIT ${QUERY_MAX_ROWS}`;
}

async function queryWithTransportRetries(
  sql: string,
  request: { log: { warn: (obj: Record<string, unknown>, msg: string) => void } },
): Promise<unknown[]> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= QUERY_TRANSPORT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await clickhouseService.query(sql);
    } catch (err) {
      lastErr = err;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorKind = classifyQueryExecutionError(errorMessage);
      if (errorKind !== "transport" || attempt >= QUERY_TRANSPORT_RETRY_ATTEMPTS) {
        throw err;
      }

      request.log.warn(
        {
          attempt: attempt + 1,
          maxAttempts: QUERY_TRANSPORT_RETRY_ATTEMPTS,
          sql,
          sqlError: errorMessage,
        },
        "Transport-level query failure; retrying identical SQL",
      );
    }
  }

  throw (lastErr ?? new Error("Query failed"));
}

export const queryRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: QueryRequest }>("/query", async (request, reply) => {
    const { message, history } = request.body;

    if (!message || typeof message !== "string") {
      return reply.status(400).send({ error: "message is required" });
    }

    // 1. Check LLM cache
    const cacheKey = JSON.stringify({ message, history, promptVersion: SYSTEM_PROMPT_VERSION });
    let llmResult = getCachedLLM(cacheKey) as LLMQueryResult | undefined;

    if (!llmResult) {
      try {
        llmResult = await generateQuery(message, history ?? []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "LLM generation failed";
        return reply.status(500).send({ error: msg });
      }
    }

    // 2. If empty SQL, return conversational response (no query needed)
    if (!llmResult.sql || llmResult.sql.trim() === "") {
      setCachedLLM(cacheKey, llmResult as unknown as Record<string, unknown>);
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

    // 4. Execute with rewrite-on-error (query cache still applies per generated SQL)
    let data: unknown[] | undefined;
    let attemptResult = llmResult;
    let lastSqlError = "";

    for (let attempt = 0; attempt <= QUERY_EXECUTION_REWRITE_ATTEMPTS; attempt++) {
      const guardrail = enforceSqlGuardrails(attemptResult.sql);
      if (!guardrail.valid) {
        lastSqlError = `${guardrail.code}: ${guardrail.reason}`;
        if (attempt >= QUERY_EXECUTION_REWRITE_ATTEMPTS) {
          return reply.status(400).send({ error: `Query blocked by guardrails: ${guardrail.reason}` });
        }

        request.log.warn(
          {
            attempt: attempt + 1,
            maxAttempts: QUERY_EXECUTION_REWRITE_ATTEMPTS,
            sql: attemptResult.sql,
            guardrailCode: guardrail.code,
            guardrailReason: guardrail.reason,
          },
          "SQL blocked by guardrails; requesting constrained rewrite",
        );

        try {
          attemptResult = await rewriteQueryAfterExecutionError({
            originalMessage: message,
            conversationHistory: history ?? [],
            previousResult: attemptResult,
            sqlError: guardrail.reason,
            failureKind: "guardrail",
            guardrailCode: guardrail.code,
          });
        } catch (rewriteErr) {
          const rewriteMsg = rewriteErr instanceof Error ? rewriteErr.message : String(rewriteErr);
          return reply.status(500).send({
            error: `Query rewrite failed: ${rewriteMsg}`,
          });
        }

        if (!attemptResult.sql || attemptResult.sql.trim() === "") {
          return reply.status(400).send({
            error: "Query rewrite failed: empty SQL returned",
          });
        }

        const rewriteValidation = validateSQL(attemptResult.sql);
        if (!rewriteValidation.valid) {
          return reply.status(400).send({ error: rewriteValidation.error });
        }
        continue;
      }

      const safeSQL = buildSafeExecutionSQL(attemptResult.sql);
      data = getCachedQuery(safeSQL);

      if (data) {
        llmResult = attemptResult;
        break;
      }

      try {
        data = await queryWithTransportRetries(safeSQL, request);
        setCachedQuery(safeSQL, data);
        llmResult = attemptResult;
        break;
      } catch (err) {
        lastSqlError = err instanceof Error ? err.message : String(err);
        const errorKind = classifyQueryExecutionError(lastSqlError);

        if (errorKind === "transport") {
          return reply.status(503).send({
            error: `Query transport failure after retries: ${lastSqlError}`,
          });
        }

        if (errorKind !== "semantic_sql") {
          return reply.status(400).send({ error: `Query failed: ${lastSqlError}` });
        }

        if (attempt >= QUERY_EXECUTION_REWRITE_ATTEMPTS) {
          return reply.status(400).send({ error: `Query failed: ${lastSqlError}` });
        }

        request.log.warn(
          {
            attempt: attempt + 1,
            maxAttempts: QUERY_EXECUTION_REWRITE_ATTEMPTS,
            sql: attemptResult.sql,
            sqlError: lastSqlError,
          },
          "Semantic SQL failure; requesting LLM rewrite",
        );

        try {
          attemptResult = await rewriteQueryAfterExecutionError({
            originalMessage: message,
            conversationHistory: history ?? [],
            previousResult: attemptResult,
            sqlError: lastSqlError,
            failureKind: "semantic_sql",
          });
        } catch (rewriteErr) {
          const rewriteMsg = rewriteErr instanceof Error ? rewriteErr.message : String(rewriteErr);
          return reply.status(500).send({
            error: `Query rewrite failed: ${rewriteMsg}`,
          });
        }

        if (!attemptResult.sql || attemptResult.sql.trim() === "") {
          return reply.status(400).send({
            error: "Query rewrite failed: empty SQL returned",
          });
        }

        const rewriteValidation = validateSQL(attemptResult.sql);
        if (!rewriteValidation.valid) {
          return reply.status(400).send({ error: rewriteValidation.error });
        }
      }
    }

    if (!data) {
      return reply.status(400).send({
        error: lastSqlError ? `Query failed: ${lastSqlError}` : "Query failed",
      });
    }

    setCachedLLM(cacheKey, llmResult as unknown as Record<string, unknown>);

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
