import manifest from "../engine-scenarios/manifest.json" with { type: "json" };

for (const scenario of manifest.scenarios) {
  console.log(`${scenario.id}\t${scenario.family}\t${scenario.reference}\t${scenario.capabilities.join(",")}`);
}
