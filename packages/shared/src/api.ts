export interface ChartConfig {
  type: "bar" | "line" | "scatter" | "area" | "pie" | "heatmap" | "histogram";
  x: string;
  y: string;
  series?: string;
  title: string;
  xLabel: string;
  yLabel: string;
}

export interface QueryRequest {
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface QueryResponse {
  data: Record<string, unknown>[];
  chart: ChartConfig;
  sql: string;
  explanation: string;
  updateWidgetId?: string;
}

export interface ErrorResponse {
  error: string;
}
