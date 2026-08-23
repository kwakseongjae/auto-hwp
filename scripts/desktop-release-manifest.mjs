#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildDesktopReleaseManifest,
  validateReleaseIdentity,
  verifyDesktopReleaseManifest,
} from "./lib/desktop-release-manifest.mjs";

function usage() {
  console.error(`usage:
  node scripts/desktop-release-manifest.mjs preflight --source-sha SHA --main-sha SHA --version SEMVER --channel preview|stable
  node scripts/desktop-release-manifest.mjs generate --spec SPEC.json --artifact-root DIR --output MANIFEST.json
  node scripts/desktop-release-manifest.mjs verify --manifest MANIFEST.json --artifact-root DIR --main-sha SHA`);
  process.exit(2);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) usage();
    const name = key.slice(2);
    if (name in options) throw new Error(`duplicate option --${name}`);
    options[name] = value;
  }
  return options;
}

function exactOptions(options, required) {
  for (const key of Object.keys(options)) {
    if (!required.includes(key)) throw new Error(`unknown option --${key}`);
  }
  for (const key of required) {
    if (!(key in options)) throw new Error(`missing option --${key}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

const [command, ...args] = process.argv.slice(2);
if (!command) usage();

try {
  const options = parseOptions(args);
  if (command === "preflight") {
    exactOptions(options, ["source-sha", "main-sha", "version", "channel"]);
    const identity = validateReleaseIdentity({
      sourceSha: options["source-sha"],
      mainSha: options["main-sha"],
      version: options.version,
      channel: options.channel,
    });
    process.stdout.write(`${JSON.stringify(identity)}\n`);
  } else if (command === "generate") {
    exactOptions(options, ["spec", "artifact-root", "output"]);
    const manifest = await buildDesktopReleaseManifest(await readJson(options.spec), options["artifact-root"]);
    await writeFile(resolve(options.output), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  } else if (command === "verify") {
    exactOptions(options, ["manifest", "artifact-root", "main-sha"]);
    await verifyDesktopReleaseManifest(
      await readJson(options.manifest),
      options["artifact-root"],
      options["main-sha"],
    );
    process.stdout.write("desktop release manifest verified\n");
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
