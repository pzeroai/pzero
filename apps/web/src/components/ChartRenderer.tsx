import type { ChartConfig } from "@p0/shared";
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

const COLORS = [
  "#22c55e", "#06b6d4", "#f59e0b", "#ef4444", "#a78bfa",
  "#ec4899", "#3b82f6", "#f97316",
];

function formatNumber(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${+(n / 1_000_000_000).toPrecision(3)}B`;
  if (abs >= 1_000_000) return `${+(n / 1_000_000).toPrecision(3)}M`;
  if (abs >= 1_000) return `${+(n / 1_000).toPrecision(3)}K`;
  return String(n);
}

/**
 * Analyze date data to pick the best tick formatter.
 * Returns a formatter + recommended tick interval.
 */
function getDateTickConfig(data: Record<string, unknown>[], xKey: string) {
  const values = data.map((d) => String(d[xKey]));
  const isDateLike = values.length > 0 && /\d{4}-\d{2}/.test(values[0]);

  if (!isDateLike) return { formatter: undefined, interval: "preserveStartEnd" as const };

  // Parse dates to determine span
  const dates = values.map((v) => new Date(v)).filter((d) => !isNaN(d.getTime()));
  if (dates.length < 2) return { formatter: undefined, interval: "preserveStartEnd" as const };

  const minDate = dates.reduce((a, b) => (a < b ? a : b));
  const maxDate = dates.reduce((a, b) => (a > b ? a : b));
  const spanDays = (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);

  if (spanDays > 365) {
    // Long duration: show quarter format 2024Q1
    return {
      formatter: (val: string) => {
        const d = new Date(val);
        if (isNaN(d.getTime())) return val;
        const q = Math.ceil((d.getMonth() + 1) / 3);
        return `${d.getFullYear()}Q${q}`;
      },
      interval: undefined, // let recharts auto-pick
    };
  }
  if (spanDays > 60) {
    // Medium duration: show Mon YYYY
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return {
      formatter: (val: string) => {
        const d = new Date(val);
        if (isNaN(d.getTime())) return val;
        return `${months[d.getMonth()]} ${d.getFullYear()}`;
      },
      interval: undefined,
    };
  }
  // Short duration: show Mon DD
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return {
    formatter: (val: string) => {
      const d = new Date(val);
      if (isNaN(d.getTime())) return val;
      return `${months[d.getMonth()]} ${d.getDate()}`;
    },
    interval: undefined,
  };
}

const LEGEND_PROPS = {
  verticalAlign: "top" as const,
  align: "right" as const,
  wrapperStyle: { fontSize: 11, right: 10, top: 0 },
  iconSize: 8,
};

const TOOLTIP_STYLE = { background: "#18181b", border: "1px solid #3f3f46", borderRadius: 0, fontSize: 12, color: "#e4e4e7" };
const TICK_STYLE = { fill: "#a1a1aa", fontSize: 11 };

interface Props {
  config: ChartConfig;
  data: Record<string, unknown>[];
}

export default function ChartRenderer({ config, data }: Props) {
  const { type, x, y, series, title, xLabel, yLabel } = config;

  if (!data.length) {
    return <div className="flex items-center justify-center h-full text-zinc-500">No data</div>;
  }

  const dateTick = getDateTickConfig(data, x);

  const common = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="rgba(113,113,122,0.2)" />
      <XAxis dataKey={x} tick={TICK_STYLE} tickFormatter={dateTick.formatter} interval={dateTick.interval ?? "preserveStartEnd"} label={xLabel ? { value: xLabel, position: "insideBottom", offset: -4, fill: "#a1a1aa", fontSize: 11 } : undefined} />
      <YAxis tick={TICK_STYLE} tickFormatter={formatNumber} width={60} label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", offset: 10, fill: "#a1a1aa", fontSize: 11 } : undefined} />
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: unknown) => formatNumber(v)} />
      <Legend {...LEGEND_PROPS} />
    </>
  );

  const wrap = (children: React.ReactNode) => (
    <ResponsiveContainer width="100%" height="100%">
      {children as React.ReactElement}
    </ResponsiveContainer>
  );

  if (type === "pie") {
    return wrap(
      <PieChart>
        <Pie data={data} dataKey={y} nameKey={x} cx="50%" cy="50%" outerRadius="70%" label={{ fill: "#d4d4d8", fontSize: 11 }}>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: unknown) => formatNumber(v)} />
        <Legend {...LEGEND_PROPS} />
      </PieChart>
    );
  }

  if (type === "bar" || type === "histogram") {
    const barColor = type === "histogram" ? COLORS[1] : COLORS[0];
    if (series) {
      const seriesValues = [...new Set(data.map((d) => String(d[series])))];
      const pivoted = Object.values(
        data.reduce<Record<string, Record<string, unknown>>>((acc, d) => {
          const key = String(d[x]);
          if (!acc[key]) acc[key] = { [x]: d[x] };
          acc[key][String(d[series])] = d[y];
          return acc;
        }, {})
      );
      return wrap(
        <BarChart data={pivoted} margin={{ top: 10, right: 30, bottom: 20, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(113,113,122,0.2)" />
          <XAxis dataKey={x} tick={TICK_STYLE} tickFormatter={dateTick.formatter} interval={dateTick.interval ?? "preserveStartEnd"} angle={-40} textAnchor="end" height={50} label={{ value: xLabel || x, position: "insideBottom", offset: 0, fill: "#71717a", fontSize: 11 }} />
          <YAxis tick={TICK_STYLE} tickFormatter={formatNumber} width={60} label={{ value: yLabel || y, angle: -90, position: "insideLeft", offset: 10, fill: "#71717a", fontSize: 11 }} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: unknown) => formatNumber(v)} />
          <Legend {...LEGEND_PROPS} />
          {seriesValues.map((s, i) => <Bar key={s} dataKey={s} fill={COLORS[i % COLORS.length]} radius={0} />)}
        </BarChart>
      );
    }

    return wrap(
      <BarChart data={data} margin={{ top: 10, right: 30, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(113,113,122,0.2)" />
        <XAxis
          dataKey={x}
          tick={TICK_STYLE}
          tickFormatter={dateTick.formatter}
          interval={dateTick.interval ?? "preserveStartEnd"}
          angle={-40}
          textAnchor="end"
          height={50}
          label={{ value: xLabel || x, position: "insideBottom", offset: 0, fill: "#71717a", fontSize: 11 }}
        />
        <YAxis
          tick={TICK_STYLE}
          tickFormatter={formatNumber}
          width={60}
          label={{ value: yLabel || y, angle: -90, position: "insideLeft", offset: 10, fill: "#71717a", fontSize: 11 }}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: unknown) => formatNumber(v)} />
        <Legend {...LEGEND_PROPS} />
        <Bar dataKey={y} fill={barColor} radius={0} />
      </BarChart>
    );
  }

  if (type === "line") {
    const isNumericX = data.length > 0 && typeof data[0][x] === "number";
    const xAxisProps = isNumericX
      ? { type: "number" as const }
      : { interval: (dateTick.interval ?? "preserveStartEnd") as "preserveStartEnd", angle: -40, textAnchor: "end" as const, height: 50 };

    if (series) {
      const seriesValues = [...new Set(data.map((d) => String(d[series])))];
      const pivoted = Object.values(
        data.reduce<Record<string, Record<string, unknown>>>((acc, d) => {
          const key = String(d[x]);
          if (!acc[key]) acc[key] = { [x]: d[x] };
          acc[key][String(d[series])] = d[y];
          return acc;
        }, {})
      );
      return wrap(
        <LineChart data={pivoted} margin={{ top: 10, right: 30, bottom: 20, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(113,113,122,0.2)" />
          <XAxis dataKey={x} tick={TICK_STYLE} tickFormatter={dateTick.formatter} {...xAxisProps} label={xLabel ? { value: xLabel, position: "insideBottom", offset: isNumericX ? -4 : 0, fill: "#71717a", fontSize: 11 } : undefined} />
          <YAxis tick={TICK_STYLE} tickFormatter={formatNumber} width={60} label={{ value: yLabel || y, angle: -90, position: "insideLeft", offset: 10, fill: "#71717a", fontSize: 11 }} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: unknown) => formatNumber(v)} />
          <Legend {...LEGEND_PROPS} />
          {seriesValues.map((s, i) => (
            <Line key={s} type="monotone" dataKey={s} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      );
    }
    return wrap(
      <LineChart data={data} margin={{ top: 10, right: 30, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(113,113,122,0.2)" />
        <XAxis dataKey={x} tick={TICK_STYLE} tickFormatter={dateTick.formatter} {...xAxisProps} label={xLabel ? { value: xLabel, position: "insideBottom", offset: isNumericX ? -4 : 0, fill: "#71717a", fontSize: 11 } : undefined} />
        <YAxis tick={TICK_STYLE} tickFormatter={formatNumber} width={60} label={{ value: yLabel || y, angle: -90, position: "insideLeft", offset: 10, fill: "#71717a", fontSize: 11 }} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: unknown) => formatNumber(v)} />
        <Legend {...LEGEND_PROPS} />
        <Line type="monotone" dataKey={y} stroke={COLORS[0]} strokeWidth={2} dot={false} />
      </LineChart>
    );
  }

  if (type === "area") {
    return wrap(
      <AreaChart data={data}>
        {common}
        <Area type="monotone" dataKey={y} stroke={COLORS[0]} fill={COLORS[0]} fillOpacity={0.2} />
      </AreaChart>
    );
  }

  if (type === "scatter") {
    return wrap(
      <ScatterChart>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(113,113,122,0.2)" />
        <XAxis dataKey={x} type="number" name={xLabel || x} tick={TICK_STYLE} label={xLabel ? { value: xLabel, position: "insideBottom", offset: -4, fill: "#a1a1aa", fontSize: 11 } : undefined} />
        <YAxis dataKey={y} type="number" name={yLabel || y} tick={TICK_STYLE} tickFormatter={formatNumber} width={60} label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", offset: 10, fill: "#a1a1aa", fontSize: 11 } : undefined} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: "3 3" }} formatter={(v: unknown) => formatNumber(v)} />
        <Legend {...LEGEND_PROPS} />
        <Scatter name={title} data={data} fill={COLORS[0]} />
      </ScatterChart>
    );
  }

  // heatmap fallback → bar
  return wrap(
    <BarChart data={data} margin={{ top: 10, right: 30, bottom: 20, left: 20 }}>
      {common}
      <Bar dataKey={y} fill={COLORS[2]} radius={0} />
    </BarChart>
  );
}
