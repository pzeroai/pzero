export interface ChartConfig {
  type: "bar" | "line" | "scatter" | "area" | "pie" | "heatmap" | "histogram" | "table";
  x: string;
  y: string;
  series?: string;
  columns?: Array<{ key: string; label: string }>;
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
