// Global coverage-floor gate.
//
// Bun's built-in `coverageThreshold` is enforced per file, which the
// experimental ContainerApp / ContainerImage and interactive auth paths would
// always trip. Bun's lcov reporter also counts non-executable lines, so the
// lcov ratio is not comparable to the headline numbers. This script therefore
// runs Bun's *text* coverage reporter (the trusted, displayed metric) and
// enforces an aggregate floor on the "All files" summary.
//
// Usage: bun run scripts/coverage-floor.ts [--min=0.70]
import { spawnSync } from "node:child_process";

const minArg = process.argv.find((arg) => arg.startsWith("--min="));
const min = minArg ? Number(minArg.slice("--min=".length)) : 0.7;

const result = spawnSync("bun", ["test", "--coverage", "--coverage-reporter=text"], {
  encoding: "utf8",
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

if (result.status !== 0) {
  console.error(output);
  console.error("Tests failed; cannot evaluate coverage.");
  process.exit(result.status ?? 1);
}

const match = output.match(/^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/m);
if (!match) {
  console.error(output);
  console.error("Could not parse coverage summary from `bun test --coverage` output.");
  process.exit(1);
}

const funcs = Number(match[1]) / 100;
const lines = Number(match[2]) / 100;
const pct = (ratio: number) => `${(ratio * 100).toFixed(2)}%`;

console.log(`Function coverage: ${pct(funcs)}`);
console.log(`Line coverage:     ${pct(lines)}`);
console.log(`Floor:             ${pct(min)}`);

if (funcs < min || lines < min) {
  console.error(`\nCoverage is below the floor of ${pct(min)}. Add tests before publishing.`);
  process.exit(1);
}
console.log(`\nCoverage is at or above the floor of ${pct(min)}.`);
