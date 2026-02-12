export interface Market {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  yes_sub_title: string;
  no_sub_title: string;
  status: "open" | "closed" | "finalized";
  yes_bid: number | null;
  yes_ask: number | null;
  no_bid: number | null;
  no_ask: number | null;
  last_price: number | null;
  volume: number;
  volume_24h: number;
  open_interest: number;
  result: "yes" | "no" | "";
  created_time: string;
  open_time: string | null;
  close_time: string | null;
  _fetched_at: string;
}

export interface Trade {
  trade_id: string;
  ticker: string;
  count: number;
  yes_price: number;
  no_price: number;
  taker_side: "yes" | "no";
  created_time: string;
  _fetched_at: string;
}
