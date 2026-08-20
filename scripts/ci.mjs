import { execFileSync } from "node:child_process";

const integration = process.argv.includes("--integration");
const steps = [
  { name: "Lint", args: ["lint"] },
  { name: "Typecheck", args: ["typecheck"] },
  { name: "Tests", args: ["test"] },
  { name: "Dependency audit", args: ["audit"] },
  ...(integration ? [{ name: "Integration tests (bwrap)", args: ["test:integration"] }] : []),
];

for (const step of steps) {
  console.log(`\n== ${step.name} ==`);
  try {
    execFileSync("pnpm", step.args, { stdio: "inherit" });
  } catch (error) {
    console.error(`\nCI failed at: ${step.name}`);
    process.exit(error.status ?? 1);
  }
}

console.log("\nCI passed.");
