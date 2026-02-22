async function main() {
  // Ensure object creation only; do not trigger any backfill/rebuild work in this CLI.
  process.env.API_MV_REBUILD = "0";
  process.env.API_MV_BACKFILL_ON_STARTUP = "0";
  process.env.API_MV_CANONICAL_BACKFILL_ON_STARTUP = "0";

  const [{ createMaterializedViews }, { clickhouseService }] = await Promise.all([
    import("../services/materialized-views"),
    import("../services/clickhouse"),
  ]);

  try {
    console.log("Ensuring ClickHouse analytics objects (no backfill)...");
    await createMaterializedViews();
    console.log("ClickHouse analytics objects ensured.");
  } finally {
    await clickhouseService.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
