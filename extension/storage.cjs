const path = require("node:path");

function databaseMigrationCandidates({ targetDirectory, platform, homeDirectory }) {
  const candidates = [
    path.join(path.dirname(targetDirectory), "local.trae-usage-monitor", "usage.db")
  ];
  if (platform === "darwin" && homeDirectory) {
    candidates.push(path.join(homeDirectory, "Library", "Application Support", "TraeUsageMonitor", "usage.db"));
  }
  return candidates.filter((candidate) => path.dirname(candidate) !== targetDirectory);
}

module.exports = { databaseMigrationCandidates };
