import { create } from "zustand";
import type { ChartConfig } from "@p0/shared";

export interface Widget {
  id: string;
  sql: string;
  data: Record<string, unknown>[];
  chart: ChartConfig;
  explanation: string;
  layout: { x: number; y: number; w: number; h: number };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  widgetId?: string;
}

interface DashboardState {
  widgets: Widget[];
  chatHistory: ChatMessage[];
  loading: boolean;
  addWidget: (widget: Widget) => void;
  removeWidget: (id: string) => void;
  updateWidget: (id: string, updates: Partial<Omit<Widget, "id" | "layout">>) => void;
  addMessage: (msg: ChatMessage) => void;
  tagLastMessages: (widgetId: string) => void;
  getMessagesForWidget: (widgetId: string) => ChatMessage[];
  setLoading: (v: boolean) => void;
}

let widgetCounter = 0;

export const useDashboardStore = create<DashboardState>((set, get) => ({
  widgets: [],
  chatHistory: [],
  loading: false,

  addWidget: (widget) =>
    set((s) => ({ widgets: [...s.widgets, widget] })),

  removeWidget: (id) =>
    set((s) => ({ widgets: s.widgets.filter((w) => w.id !== id) })),

  updateWidget: (id, updates) =>
    set((s) => ({
      widgets: s.widgets.map((w) => (w.id === id ? { ...w, ...updates } : w)),
    })),

  addMessage: (msg) =>
    set((s) => ({ chatHistory: [...s.chatHistory, msg] })),

  tagLastMessages: (widgetId) =>
    set((s) => {
      const history = [...s.chatHistory];
      for (let i = history.length - 1; i >= 0; i--) {
        if (!history[i].widgetId && history[i].role === "assistant") {
          history[i] = { ...history[i], widgetId };
          for (let j = i - 1; j >= 0; j--) {
            if (!history[j].widgetId && history[j].role === "user") {
              history[j] = { ...history[j], widgetId };
              break;
            }
          }
          break;
        }
      }
      return { chatHistory: history };
    }),

  getMessagesForWidget: (widgetId) => {
    return get().chatHistory.filter((m) => m.widgetId === widgetId);
  },

  setLoading: (loading) => set({ loading }),
}));

export function nextWidgetId() {
  return `widget-${++widgetCounter}`;
}

export function nextWidgetLayout(widgetCount: number) {
  const col = widgetCount % 2;
  const row = Math.floor(widgetCount / 2);
  return { x: col * 6, y: row * 4, w: 6, h: 4 };
}
