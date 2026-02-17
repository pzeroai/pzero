import cron from "node-cron";
import { Indexer } from "./common/indexer";

const SCHEDULES: Record<string, string> = {
  polymarket_markets: "*/5 * * * *", // every 5 min
  polymarket_trades: "*/15 * * * *", // every 15 min
  polymarket_fpmm_trades: "0 * * * *", // every hour
};

async function main() {
  const indexers = await Indexer.load();
  const running = new Set<string>();

  console.log("Starting indexer scheduler...\n");

  for (const indexer of indexers) {
    const schedule = SCHEDULES[indexer.name];
    if (!schedule) {
      console.log(`  No schedule for ${indexer.name}, skipping`);
      continue;
    }

    console.log(`  ${indexer.name}: ${schedule}`);

    cron.schedule(schedule, async () => {
      if (running.has(indexer.name)) {
        console.log(`[${indexer.name}] Still running, skipping`);
        return;
      }

      running.add(indexer.name);
      const start = Date.now();
      console.log(`[${indexer.name}] Starting...`);

      try {
        await indexer.run();
        console.log(
          `[${indexer.name}] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`,
        );
      } catch (err) {
        console.error(`[${indexer.name}] Error:`, err);
      } finally {
        running.delete(indexer.name);
      }
    });
  }

  console.log("\nScheduler running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
