#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = process.cwd();
const VERSIONS_PATH = resolve(ROOT, "versions.json");

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`Invalid version "${v}" (expected major.minor.patch.build)`);
  return {
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: Number.parseInt(m[3], 10),
    build: Number.parseInt(m[4], 10),
  };
}

function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}.${v.build}`;
}

function toSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function replaceAllOrThrow(input, matcher, replacement, label) {
  const regex = new RegExp(matcher.source, matcher.flags);
  if (!regex.test(input)) {
    throw new Error(`Could not update ${label}`);
  }
  return input.replace(matcher, replacement);
}

async function updateDesktop(targetVersion) {
  const semver = toSemver(targetVersion);
  const display = formatVersion(targetVersion);

  const versionTsPath = resolve(ROOT, "desktop/src/version.ts");
  let versionTs = await readFile(versionTsPath, "utf8");
  versionTs = replaceAllOrThrow(
    versionTs,
    /export const APP_VERSION_SEMVER = ".*";/,
    `export const APP_VERSION_SEMVER = "${semver}";`,
    "desktop/src/version.ts semver",
  );
  versionTs = replaceAllOrThrow(
    versionTs,
    /export const APP_VERSION_DISPLAY = "\[.*\]";/,
    `export const APP_VERSION_DISPLAY = "[${display}]";`,
    "desktop/src/version.ts display",
  );
  await writeFile(versionTsPath, versionTs, "utf8");

  const tauriPath = resolve(ROOT, "desktop/src-tauri/tauri.conf.json");
  const tauri = JSON.parse(await readFile(tauriPath, "utf8"));
  tauri.version = semver;
  if (tauri?.app?.windows?.[0]) {
    tauri.app.windows[0].title = `PhishingKiller [${display}]`;
  }
  await writeFile(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`, "utf8");

  const desktopPkgPath = resolve(ROOT, "desktop/package.json");
  const desktopPkg = JSON.parse(await readFile(desktopPkgPath, "utf8"));
  desktopPkg.version = semver;
  await writeFile(desktopPkgPath, `${JSON.stringify(desktopPkg, null, 2)}\n`, "utf8");

  const cargoPath = resolve(ROOT, "desktop/src-tauri/Cargo.toml");
  let cargo = await readFile(cargoPath, "utf8");
  cargo = replaceAllOrThrow(
    cargo,
    /^version = ".*"$/m,
    `version = "${semver}"`,
    "desktop/src-tauri/Cargo.toml version",
  );
  await writeFile(cargoPath, cargo, "utf8");
}

async function updateNetlify(targetVersion) {
  const semver = toSemver(targetVersion);
  const display = formatVersion(targetVersion);

  const netlifyPkgPath = resolve(ROOT, "netlify/package.json");
  const netlifyPkg = JSON.parse(await readFile(netlifyPkgPath, "utf8"));
  netlifyPkg.version = semver;
  await writeFile(netlifyPkgPath, `${JSON.stringify(netlifyPkg, null, 2)}\n`, "utf8");

  const runtimePath = resolve(ROOT, "netlify/src/runtime.ts");
  let runtime = await readFile(runtimePath, "utf8");
  runtime = replaceAllOrThrow(
    runtime,
    /export const NETLIFY_VERSION_DISPLAY = ".*";/,
    `export const NETLIFY_VERSION_DISPLAY = "${display}";`,
    "netlify/src/runtime.ts NETLIFY_VERSION_DISPLAY",
  );
  await writeFile(runtimePath, runtime, "utf8");
}

function parseArgs(argv) {
  const out = {
    target: "all",
    set: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") {
      out.target = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--set") {
      out.set = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!["desktop", "netlify", "all"].includes(args.target)) {
    throw new Error(`Invalid --target "${args.target}" (desktop|netlify|all)`);
  }

  const versions = JSON.parse(await readFile(VERSIONS_PATH, "utf8"));

  const targets = args.target === "all" ? ["desktop", "netlify"] : [args.target];
  for (const target of targets) {
    const parsed = parseVersion(versions[target]);
    const next = args.set ? parseVersion(args.set) : { ...parsed, build: parsed.build + 1 };
    versions[target] = formatVersion(next);

    if (target === "desktop") {
      await updateDesktop(next);
    } else {
      await updateNetlify(next);
    }
  }

  await writeFile(VERSIONS_PATH, `${JSON.stringify(versions, null, 2)}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `Updated versions: desktop=${versions.desktop} netlify=${versions.netlify}`,
  );
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
