import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { polygon } from "viem/chains";
import type { BlockchainTrade, FPMMTrade } from "./models";

export const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const NEGRISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
export const POLYMARKET_START_BLOCK = parseInt(
  process.env.POLYMARKET_START_BLOCK || "33605403",
  10,
);
export const FPMM_START_BLOCK = 4023693;

const ORDER_FILLED_EVENT = parseAbiItem(
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
);

const FPMM_BUY_EVENT = parseAbiItem(
  "event FPMMBuy(address indexed buyer, uint256 investmentAmount, uint256 feeAmount, uint256 indexed outcomeIndex, uint256 outcomeTokensBought)",
);

const FPMM_SELL_EVENT = parseAbiItem(
  "event FPMMSell(address indexed seller, uint256 returnAmount, uint256 feeAmount, uint256 indexed outcomeIndex, uint256 outcomeTokensSold)",
);

export class PolygonClient {
  private client;

  constructor(rpcUrl?: string) {
    const url = rpcUrl || process.env.POLYGON_RPC || "";
    if (!url) throw new Error("POLYGON_RPC environment variable is required");
    this.client = createPublicClient({
      chain: polygon,
      transport: http(url, { timeout: 30_000 }),
    });
  }

  async getBlockNumber(): Promise<number> {
    return Number(await this.client.getBlockNumber());
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    const block = await this.client.getBlock({ blockNumber: BigInt(blockNumber) });
    return Number(block.timestamp);
  }

  async getOrderFilledTrades(
    fromBlock: number,
    toBlock: number,
    contractAddress: string,
  ): Promise<BlockchainTrade[]> {
    try {
      const logs = await this.client.getLogs({
        address: getAddress(contractAddress) as `0x${string}`,
        event: ORDER_FILLED_EVENT,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      });

      return logs.map((log) => ({
        block_number: Number(log.blockNumber),
        transaction_hash: log.transactionHash,
        log_index: Number(log.logIndex),
        order_hash: (log.args as any).orderHash,
        maker: (log.args as any).maker,
        taker: (log.args as any).taker,
        maker_asset_id: String((log.args as any).makerAssetId),
        taker_asset_id: String((log.args as any).takerAssetId),
        maker_amount: Number((log.args as any).makerAmountFilled),
        taker_amount: Number((log.args as any).takerAmountFilled),
        fee: Number((log.args as any).fee),
      }));
    } catch (err) {
      const msg = String(err).toLowerCase();
      const shouldSplit =
        msg.includes("too large") ||
        msg.includes("response size exceeded") ||
        msg.includes("query returned more than");
      if (shouldSplit) {
        if (fromBlock >= toBlock) {
          throw new Error(
            `Cannot split OrderFilled log query further at block ${fromBlock}: ${String(err)}`,
          );
        }
        const mid = Math.floor((fromBlock + toBlock) / 2);
        const left = await this.getOrderFilledTrades(fromBlock, mid, contractAddress);
        const right = await this.getOrderFilledTrades(mid + 1, toBlock, contractAddress);
        return [...left, ...right];
      }
      throw err;
    }
  }

  async getFPMMTrades(
    fromBlock: number,
    toBlock: number,
  ): Promise<FPMMTrade[]> {
    const trades: FPMMTrade[] = [];

    const fetchLogsRange = async (
      event: typeof FPMM_BUY_EVENT | typeof FPMM_SELL_EVENT,
      startBlock: number,
      endBlock: number,
    ): Promise<any[]> => {
      try {
        return await this.client.getLogs({
          event,
          fromBlock: BigInt(startBlock),
          toBlock: BigInt(endBlock),
        });
      } catch (err) {
        if (String(err).toLowerCase().includes("too large") && startBlock < endBlock) {
          const mid = Math.floor((startBlock + endBlock) / 2);
          const left = await fetchLogsRange(event, startBlock, mid);
          const right = await fetchLogsRange(event, mid + 1, endBlock);
          return [...left, ...right];
        }
        throw err;
      }
    };

    const buyLogs = await fetchLogsRange(FPMM_BUY_EVENT, fromBlock, toBlock);
    for (const log of buyLogs) {
      const args = log.args as any;
      trades.push({
        block_number: Number(log.blockNumber),
        transaction_hash: log.transactionHash,
        log_index: Number(log.logIndex),
        fpmm_address: log.address,
        trader: args.buyer,
        amount: String(args.investmentAmount),
        fee_amount: String(args.feeAmount),
        outcome_index: Number(args.outcomeIndex),
        outcome_tokens: String(args.outcomeTokensBought),
        is_buy: true,
        timestamp: null,
      });
    }

    const sellLogs = await fetchLogsRange(FPMM_SELL_EVENT, fromBlock, toBlock);
    for (const log of sellLogs) {
      const args = log.args as any;
      trades.push({
        block_number: Number(log.blockNumber),
        transaction_hash: log.transactionHash,
        log_index: Number(log.logIndex),
        fpmm_address: log.address,
        trader: args.seller,
        amount: String(args.returnAmount),
        fee_amount: String(args.feeAmount),
        outcome_index: Number(args.outcomeIndex),
        outcome_tokens: String(args.outcomeTokensSold),
        is_buy: false,
        timestamp: null,
      });
    }

    return trades;
  }
}
