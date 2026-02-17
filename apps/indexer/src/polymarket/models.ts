export interface PolymarketMarket {
  id: string;
  condition_id: string;
  question: string;
  slug: string;
  outcomes: string;
  outcome_prices: string;
  clob_token_ids: string;
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  end_date: string | null;
  created_at: string | null;
  category: string | null;
  tags: string;
  description: string | null;
  image: string | null;
  icon: string | null;
}

export interface BlockchainTrade {
  block_number: number;
  transaction_hash: string;
  log_index: number;
  order_hash: string;
  maker: string;
  taker: string;
  maker_asset_id: string; // uint256 stored as string
  taker_asset_id: string;
  maker_amount: number;
  taker_amount: number;
  fee: number;
}

export interface FPMMTrade {
  block_number: number;
  transaction_hash: string;
  log_index: number;
  fpmm_address: string;
  trader: string;
  amount: string; // large int as string
  fee_amount: string;
  outcome_index: number;
  outcome_tokens: string; // 18 decimal as string
  is_buy: boolean;
  timestamp: number | null;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function toJsonArrayString(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return "[]";
    // Polymarket sometimes returns arrays already JSON-encoded as strings.
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);
    } catch {
      // Ignore parse errors and fallback to empty array.
    }
  }
  return "[]";
}

function toJsonString(value: unknown, fallback = "[]"): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

export function marketFromApi(data: Record<string, unknown>): PolymarketMarket {
  const category =
    toStringOrNull(data.category) ??
    toStringOrNull((data as { groupItemTitle?: unknown }).groupItemTitle) ??
    toStringOrNull((data as { series?: unknown }).series);

  return {
    id: String(data.id ?? ""),
    condition_id: String(data.conditionId ?? ""),
    question: String(data.question ?? ""),
    slug: String(data.slug ?? ""),
    outcomes: toJsonArrayString(data.outcomes),
    outcome_prices: toJsonArrayString(data.outcomePrices),
    clob_token_ids: toJsonArrayString(data.clobTokenIds),
    volume: Number(data.volume ?? 0) || 0,
    liquidity: Number(data.liquidity ?? 0) || 0,
    active: Boolean(data.active),
    closed: Boolean(data.closed),
    end_date: toStringOrNull(data.endDate),
    created_at: toStringOrNull(data.createdAt),
    category,
    tags: toJsonString(data.tags, "[]"),
    description: toStringOrNull(data.description),
    image: toStringOrNull(data.image),
    icon: toStringOrNull(data.icon),
  };
}
