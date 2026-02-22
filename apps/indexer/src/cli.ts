import { Indexer } from "./common/indexer";

async function main() {
  const indexers = await Indexer.load();
  const names = process.argv.slice(2);

  if (names.length === 0) {
    console.log("Available indexers:");
    for (const idx of indexers) {
      console.log(`  ${idx.name.padEnd(30)} ${idx.description}`);
    }
    console.log("\nUsage: bun run index <name> [name2 ...]");
    console.log("       bun run index all");
    process.exit(0);
  }

  const toRun = names.includes("all")
    ? indexers
    : names.map((name) => {
        const indexer = indexers.find((i) => i.name === name);
        if (!indexer) {
          console.error(`Unknown indexer: ${name}`);
          console.error(`Available: ${indexers.map((i) => i.name).join(", ")}`);
          process.exit(1);
        }
        return indexer!;
      });

  for (const idx of toRun) {
    if (toRun.length > 1) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Running: ${idx.name}`);
      console.log("=".repeat(60));
    }
    await idx.run();
  }
}

main()
  .then(() => {
    // Ensure Bun exits after indexer tasks complete.
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
