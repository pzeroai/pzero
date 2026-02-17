export abstract class Indexer {
  constructor(
    public name: string,
    public description: string,
  ) {}

  abstract run(): Promise<void>;

  static async load(): Promise<Indexer[]> {
    const modules = await Promise.all([
      import("../kalshi/markets"),
      import("../kalshi/trades"),
      import("../polymarket/markets"),
      import("../polymarket/trades"),
      import("../polymarket/trades-backfill-timestamps"),
      import("../polymarket/blocks"),
      import("../polymarket/fpmm-trades"),
    ]);

    const indexers: Indexer[] = [];
    for (const mod of modules) {
      const IndexerClass = Object.values(mod).find(
        (v) => typeof v === "function" && v.prototype instanceof Indexer,
      ) as (new () => Indexer) | undefined;
      if (IndexerClass) {
        indexers.push(new IndexerClass());
      }
    }
    return indexers;
  }
}
