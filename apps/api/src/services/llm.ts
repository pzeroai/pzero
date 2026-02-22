import OpenAI from "openai";
import { SYSTEM_PROMPT } from "../lib/system-prompt";
import type { ChartConfig } from "@p0/shared";

const client = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
});

const model = process.env.LLM_MODEL || "gpt-4o";

export interface LLMQueryResult {
  sql: string;
  chart: ChartConfig;
  explanation: string;
  updateWidgetId?: string;
}

export interface QueryRewriteContext {
  originalMessage: string;
  conversationHistory: Array<{ role: string; content: string }>;
  previousResult: LLMQueryResult;
  sqlError: string;
  failureKind?: "semantic_sql" | "guardrail";
  guardrailCode?: string;
}

export async function generateQuery(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
): Promise<LLMQueryResult> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content ?? "{}");
}

export async function rewriteQueryAfterExecutionError(
  context: QueryRewriteContext,
): Promise<LLMQueryResult> {
  const truncatedError = context.sqlError.length > 2_000
    ? `${context.sqlError.slice(0, 2_000)}...`
    : context.sqlError;

  const failureHeader = context.failureKind === "guardrail"
    ? "The previous SQL was blocked by pre-execution guardrails."
    : "The previous SQL failed when executed in ClickHouse.";

  const rewriteMessage = [
    failureHeader,
    "Rewrite the query to preserve the original user intent and chart intent.",
    "Do not remove any explicit filters/constraints from the original request; keep them or make them stricter.",
    "Only use known columns/tables. Do not invent identifiers.",
    ...(context.guardrailCode ? [`Guardrail code: ${context.guardrailCode}`] : []),
    "Use the same response JSON schema as before.",
    "",
    `Original user request:\n${context.originalMessage}`,
    "",
    `Previous assistant JSON:\n${JSON.stringify(context.previousResult)}`,
    "",
    `Execution error:\n${truncatedError}`,
  ].join("\n");

  const repairHistory = [
    ...context.conversationHistory,
    { role: "user", content: context.originalMessage },
    { role: "assistant", content: JSON.stringify(context.previousResult) },
  ];

  return await generateQuery(rewriteMessage, repairHistory);
}
