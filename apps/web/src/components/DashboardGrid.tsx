import { useMemo } from "react";
import GridLayout from "react-grid-layout";
import { useDashboardStore } from "../store/dashboard";
import WidgetCard from "./WidgetCard";

export default function DashboardGrid() {
  const widgets = useDashboardStore((s) => s.widgets);

  const layout = useMemo(
    () =>
      widgets.map((w) => ({
        i: w.id,
        ...w.layout,
        minW: 3,
        minH: 3,
      })),
    [widgets]
  );

  if (!widgets.length) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3 text-zinc-700">
            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
          </svg>
          <p className="text-sm text-zinc-500">
            Ask a question in the chat to generate your first chart.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <GridLayout
        className="layout"
        layout={layout}
        cols={12}
        rowHeight={80}
        width={1200}
        draggableHandle=".drag-handle"
        compactType="vertical"
        isResizable
      >
        {widgets.map((w) => (
          <div key={w.id}>
            <WidgetCard widget={w} />
          </div>
        ))}
      </GridLayout>
    </div>
  );
}
