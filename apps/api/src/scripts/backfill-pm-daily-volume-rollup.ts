import { clickhouseService } from "../services/clickhouse";
import { backfillPmDailyVolumeRollup } from "../services/materialized-views";

interface CliOptions {
  rebuild: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    rebuild: argv.includes("--rebuild") || argv.includes("--truncate"),
    force: argv.includes("--force"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `Backfilling pm_daily_volume_rollup (rebuild=${options.rebuild}, force=${options.force})`,
  );

  try {
    await backfillPmDailyVolumeRollup({
      rebuild: options.rebuild,
      skipIfNotEmpty: !options.rebuild && !options.force,
      ensureObjects: true,
    });

    console.log("pm_daily_volume_rollup backfill complete.");
  } finally {
    await clickhouseService.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
