import { useState, useRef, useEffect } from "react";
import { useDashboardStore, nextWidgetId, nextWidgetLayout } from "../store/dashboard";
import { queryApi } from "../lib/api";
import MessageBubble from "./MessageBubble";

export default function ChatPanel() {
  const [input, setInput] = useState("");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const {
    chatHistory, loading, widgets,
    addMessage, addWidget, updateWidget, tagLastMessages, setLoading,
  } = useDashboardStore();

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  function buildWidgetContext(): string {
    if (widgets.length === 0) return "";
    const list = widgets.map((w, i) => `  ${i + 1}. id="${w.id}" title="${w.chart.title}"`).join("\n");
    return `[Current dashboard widgets (left-to-right, top-to-bottom):\n${list}\nIf the user refers to an existing chart, set updateWidgetId to its id.]`;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const msg = input.trim();
    if (!msg || loading) return;

    setInput("");
    addMessage({ role: "user", content: msg });
    setLoading(true);

    try {
      const history = chatHistory.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Inject widget context as a system-like message so the LLM knows what's on the dashboard
      const widgetCtx = buildWidgetContext();
      if (widgetCtx) {
        history.push({ role: "user" as const, content: widgetCtx });
        history.push({ role: "assistant" as const, content: "Understood, I can see the current dashboard widgets." });
      }

      const res = await queryApi(msg, history);

      addMessage({ role: "assistant", content: res.explanation });

      if (res.data && res.data.length > 0) {
        if (res.updateWidgetId && widgets.some((w) => w.id === res.updateWidgetId)) {
          // Update existing widget
          updateWidget(res.updateWidgetId, {
            sql: res.sql,
            data: res.data,
            chart: res.chart,
            explanation: res.explanation,
          });
          tagLastMessages(res.updateWidgetId);
        } else {
          // Create new widget
          const widgetId = nextWidgetId();
          addWidget({
            id: widgetId,
            sql: res.sql,
            data: res.data,
            chart: res.chart,
            explanation: res.explanation,
            layout: nextWidgetLayout(widgets.length),
          });
          tagLastMessages(widgetId);
        }
      }
    } catch (err) {
      addMessage({
        role: "assistant",
        content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-96 border-r border-zinc-800 flex flex-col bg-zinc-950 shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800">
        <h2 className="text-lg font-bold tracking-tight text-green-400">p[0]</h2>
        <p className="text-[11px] text-zinc-500 mt-0.5">vibe analytics for prediction markets</p>
      </div>

      {/* Messages */}
      <div className="chat-scroll flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-3">
        {chatHistory.length === 0 && (
          <div className="text-center py-8">
            <p className="text-xs text-zinc-600">Try asking:</p>
            <div className="mt-2 space-y-1.5">
              {[
                "Compare Kalshi vs Polymarket daily volume over time",
                "What are the top Kalshi categories by trading volume?",
                "How calibrated are Kalshi and Polymarket? Plot win rate vs price",
                "Show the top 10 highest-volume Polymarket markets",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => setInput(q)}
                  className="block w-full text-left text-xs text-zinc-400 hover:text-green-400 bg-zinc-900 hover:bg-zinc-800 rounded-none px-3 py-2 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {chatHistory.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-zinc-800 rounded-none px-3 py-2">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEnd} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-zinc-800">
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder="Ask about the data..."
            disabled={loading}
            rows={4}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-none px-4 py-3 pr-12 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 disabled:opacity-50 resize-none"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="absolute bottom-2 right-0 p-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:hover:bg-green-600 rounded-none text-sm font-medium transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
