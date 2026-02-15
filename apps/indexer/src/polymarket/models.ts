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

export function marketFromApi(data: Record<string, unknown>): PolymarketMarket {
  return {
    id: String(data.id ?? ""),
    condition_id: String(data.conditionId ?? ""),
    question: String(data.question ?? ""),
    slug: String(data.slug ?? ""),
    outcomes: String(data.outcomes ?? "[]"),
    outcome_prices: String(data.outcomePrices ?? "[]"),
    clob_token_ids: String(data.clobTokenIds ?? "[]"),
    volume: Number(data.volume ?? 0) || 0,
    liquidity: Number(data.liquidity ?? 0) || 0,
    active: Boolean(data.active),
    closed: Boolean(data.closed),
    end_date: data.endDate ? String(data.endDate) : null,
    created_at: data.createdAt ? String(data.createdAt) : null,
  };
}
