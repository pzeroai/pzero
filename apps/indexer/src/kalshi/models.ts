export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  yes_sub_title: string;
  no_sub_title: string;
  status: string;
  yes_bid: number | null;
  yes_ask: number | null;
  no_bid: number | null;
  no_ask: number | null;
  last_price: number | null;
  volume: number;
  volume_24h: number;
  open_interest: number;
  result: string;
  created_time: string | null;
  open_time: string | null;
  close_time: string | null;
}

export interface KalshiTrade {
  trade_id: string;
  ticker: string;
  count: number;
  yes_price: number;
  no_price: number;
  taker_side: string;
  created_time: string;
}

export function marketFromApi(data: Record<string, unknown>): KalshiMarket {
  return {
    ticker: String(data.ticker ?? ""),
    event_ticker: String(data.event_ticker ?? ""),
    market_type: String(data.market_type ?? "binary"),
    title: String(data.title ?? ""),
    yes_sub_title: String(data.yes_sub_title ?? ""),
    no_sub_title: String(data.no_sub_title ?? ""),
    status: String(data.status ?? ""),
    yes_bid: data.yes_bid != null ? Number(data.yes_bid) : null,
    yes_ask: data.yes_ask != null ? Number(data.yes_ask) : null,
    no_bid: data.no_bid != null ? Number(data.no_bid) : null,
    no_ask: data.no_ask != null ? Number(data.no_ask) : null,
    last_price: data.last_price != null ? Number(data.last_price) : null,
    volume: Number(data.volume ?? 0),
    volume_24h: Number(data.volume_24h ?? 0),
    open_interest: Number(data.open_interest ?? 0),
    result: String(data.result ?? ""),
    created_time: data.created_time ? String(data.created_time) : null,
    open_time: data.open_time ? String(data.open_time) : null,
    close_time: data.close_time ? String(data.close_time) : null,
  };
}

export function tradeFromApi(data: Record<string, unknown>): KalshiTrade {
  return {
    trade_id: String(data.trade_id ?? ""),
    ticker: String(data.ticker ?? ""),
    count: Number(data.count ?? 0),
    yes_price: Number(data.yes_price ?? 0),
    no_price: Number(data.no_price ?? 0),
    taker_side: String(data.taker_side ?? ""),
    created_time: String(data.created_time ?? ""),
  };
}
