import type { ChartConfig } from "@p0/shared";

function formatNumber(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${+(n / 1_000_000_000).toPrecision(3)}B`;
  if (abs >= 1_000_000) return `${+(n / 1_000_000).toPrecision(3)}M`;
  if (abs >= 1_000) return `${+(n / 1_000).toPrecision(3)}K`;
  if (!Number.isInteger(n)) return n.toFixed(2);
  return String(n);
}

function formatCell(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "number") return formatNumber(value);
  return String(value);
}

interface Props {
  config: ChartConfig;
  data: Record<string, unknown>[];
}

export default function TableRenderer({ config, data }: Props) {
  if (!data.length) {
    return <div className="flex items-center justify-center h-full text-zinc-500">No data</div>;
  }

  const columns = config.columns?.length
    ? config.columns
    : Object.keys(data[0]).map((key) => ({ key, label: key }));

  return (
    <div className="h-full overflow-auto chat-scroll">
      <table className="w-full text-xs text-left border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-zinc-800 border-b border-zinc-700">
            {columns.map((col) => (
              <th
                key={col.key}
                className="px-3 py-2 text-zinc-300 font-medium whitespace-nowrap"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr
              key={i}
              className={`border-b border-zinc-800/50 ${
                i % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900/50"
              } hover:bg-zinc-800/50 transition-colors`}
            >
              {columns.map((col) => (
                <td key={col.key} className="px-3 py-1.5 text-zinc-300 whitespace-nowrap">
                  {formatCell(row[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
