import { measureKernelScenario } from "./engine-kernel-scenarios.mjs";

const result = measureKernelScenario(process.argv[2]);
process.stdout.write(`${JSON.stringify(result)}\n`);
