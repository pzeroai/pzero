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
