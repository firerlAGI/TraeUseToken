const path = require("node:path");

function databaseMigrationCandidates({ targetDirectory, platform, homeDirectory }) {
  const targetPath = platform === "darwin" ? path.posix : platform === "win32" ? path.win32 : path;
  const parent = targetPath.dirname(targetDirectory);
  const candidates = [
    targetPath.join(parent, "firerl.trae-usage-monitor", "usage.db"),
    targetPath.join(parent, "firerlAGI.trae-usage-monitor", "usage.db"),
    targetPath.join(parent, "local.trae-usage-monitor", "usage.db")
  ];
  if (platform === "darwin" && homeDirectory) {
    candidates.push(targetPath.join(homeDirectory, "Library", "Application Support", "TraeUsageMonitor", "usage.db"));
  }
  return candidates.filter((candidate) => targetPath.dirname(candidate) !== targetDirectory);
}

module.exports = { databaseMigrationCandidates };
