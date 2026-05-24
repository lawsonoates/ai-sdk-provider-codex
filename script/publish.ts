#!/usr/bin/env bun

import { $ } from "bun";

const PACKAGE_JSON_PATH = "package.json";
const RELEASE_BRANCH = "master";
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

interface PackageJson {
  name: string;
  version: string;
}

const version = Bun.argv[2];
if (!version || !VERSION_PATTERN.test(version)) {
  console.error("Usage: bun run release <semver>");
  process.exit(1);
}

const text = await Bun.file(PACKAGE_JSON_PATH).text();
const packageJson = JSON.parse(text) as PackageJson;
const branch = (await $`git branch --show-current`.text()).trim();

if (packageJson.version === version) {
  console.error(`${packageJson.name} is already at v${version}.`);
  process.exit(1);
}

if (branch !== RELEASE_BRANCH) {
  console.error(
    `Refusing to release from "${branch}". Switch to "${RELEASE_BRANCH}" first.`
  );
  process.exit(1);
}

const status = (await $`git status --porcelain`.text()).trim();
if (status) {
  console.error("Refusing to release with uncommitted changes.");
  process.exit(1);
}

console.log(`\n=== releasing ${packageJson.name} v${version} ===\n`);

const next = text.replace(
  /"version"\s*:\s*"[^"]+"/u,
  `"version": "${version}"`
);

await Bun.file(PACKAGE_JSON_PATH).write(next);
console.log(`updated: ${PACKAGE_JSON_PATH}`);

await $`bun install`;
await $`bun run check`;
await $`bun run build`;

console.log(`\n=== publishing ${packageJson.name} ===\n`);
await $`npm publish --access public --ignore-scripts`;

await $`git add package.json bun.lock`;
await $`git commit -m ${`release: ${packageJson.name} v${version}`}`;
await $`git tag ${`v${version}`}`;
await $`git push --follow-tags`;

console.log(`\n=== done: ${packageJson.name} v${version} ===\n`);
