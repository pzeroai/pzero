import { useState, useRef } from "react";
import type { Widget } from "../store/dashboard";
import { useDashboardStore } from "../store/dashboard";
import { queryApi } from "../lib/api";
import ChartRenderer from "./ChartRenderer";

interface RefineMessage {
  role: "user" | "assistant";
  content: string;
}

export default function WidgetCard({ widget }: { widget: Widget }) {
  const [refining, setRefining] = useState(false);
  const [refineInput, setRefineInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [refineHistory, setRefineHistory] = useState<RefineMessage[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeWidget = useDashboardStore((s) => s.removeWidget);
  const updateWidget = useDashboardStore((s) => s.updateWidget);
  const getMessagesForWidget = useDashboardStore((s) => s.getMessagesForWidget);

  async function handleRefine(e: React.FormEvent) {
    e.preventDefault();
    const instruction = refineInput.trim();
    if (!instruction || loading) return;

    setLoading(true);
    try {
      const originMessages = getMessagesForWidget(widget.id).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const context: RefineMessage[] = [
        ...originMessages,
        {
          role: "assistant",
          content: JSON.stringify({
            sql: widget.sql,
            chart: widget.chart,
            explanation: widget.explanation,
          }),
        },
        ...refineHistory,
      ];
      const res = await queryApi(instruction, context);

      setRefineHistory((prev) => [
        ...prev,
        { role: "user", content: instruction },
        {
          role: "assistant",
          content: JSON.stringify({
            sql: res.sql,
            chart: res.chart,
            explanation: res.explanation,
          }),
        },
      ]);

      if (res.data && res.data.length > 0) {
        updateWidget(widget.id, {
          sql: res.sql,
          data: res.data,
          chart: res.chart,
          explanation: res.explanation,
        });
      }
      setRefineInput("");
    } catch (err) {
      setRefineInput(
        `Error: ${err instanceof Error ? err.message : "Something went wrong"}. Try again.`
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full flex flex-col bg-zinc-950 border border-zinc-700 rounded-none overflow-hidden">
      {/* Header — draggable handle */}
      <div className="drag-handle flex items-center justify-between px-3 py-2 border-b border-zinc-800 cursor-grab active:cursor-grabbing shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <h3 className="text-sm font-medium text-zinc-200 truncate">
            {widget.chart.title}
          </h3>
          <div className="relative group shrink-0" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500 hover:text-zinc-300 cursor-help">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <div className="absolute left-0 top-full mt-1 z-50 w-64 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-none shadow-lg text-[11px] text-zinc-400 leading-relaxed opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
              {widget.explanation}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              setRefining(!refining);
              if (!refining) setTimeout(() => inputRef.current?.focus(), 50);
            }}
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-none bg-zinc-800 text-zinc-400 hover:text-green-400 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Refine
          </button>
          <button
            onClick={() => removeWidget(widget.id)}
            className="text-zinc-500 hover:text-red-400 transition-colors ml-1"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Refine Panel */}
      {refining && (
        <form onSubmit={handleRefine} className="px-3 py-2 bg-zinc-950 border-b border-zinc-800 shrink-0">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={refineInput}
              onChange={(e) => setRefineInput(e.target.value)}
              placeholder="e.g. filter to Sports, make it a line chart..."
              disabled={loading}
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-none px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-green-500 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={loading || !refineInput.trim()}
              className="px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded-none text-xs font-medium transition-colors"
            >
              {loading ? "..." : "Go"}
            </button>
          </div>
        </form>
      )}

      {/* Chart */}
      <div className="flex-1 p-2 min-h-0">
        <ChartRenderer config={widget.chart} data={widget.data} />
      </div>

    </div>
  );
}
