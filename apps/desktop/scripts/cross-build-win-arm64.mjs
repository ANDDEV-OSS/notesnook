/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/**
 * Builds an unsigned Windows ARM64 package of the desktop app on a Linux (or
 * other non Windows ARM64) machine.
 *
 * Why this exists:
 * - Building the JS natively on Windows ARM64 produces a broken app because
 *   @swc/core for win32-arm64 can't run WASM plugins, so @lingui/swc-plugin is
 *   skipped & the main process crashes on startup.
 * - better-sqlite3-multiple-ciphers is compiled from source with
 *   SQLITE_ENABLE_REGEXP (see patches/) which can't be done for win32-arm64
 *   from Linux. Instead, the binary built by the official release of the same
 *   version is reused (the Electron & better-sqlite3 versions must match).
 *
 * Usage (from apps/desktop, after bootstrapping):
 *   node scripts/cross-build-win-arm64.mjs [--target=dir,portable] [--release=v3.4.8]
 *     [--skip-js] [--product-name="Notesnook Popout"] [--app-id=...]
 *
 * Requires `7z` (Debian: `7zip` or `p7zip-full`) on the PATH.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const pkg = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf-8")
);
const args = yargs(process.argv.slice(2), {
  string: ["target", "release", "product-name", "app-id"],
  boolean: ["skip-js"]
});
const targets = (args.target || "dir,portable").split(",");
const release = args.release || `v${pkg.version}`;
const productName = args.productName || "Notesnook Popout";
const appId = args.appId || "dev.anddev.notesnook.popout";
const cacheDir = path.join(root, "output", ".cross-build-cache", release);
const SQLITE_MODULE = "better-sqlite3-multiple-ciphers";
const SQLITE_BINARY = path.join("build", "Release", "better_sqlite3.node");

function exec(cmd, cwd = root, env = {}) {
  console.log(">", cmd);
  return execSync(cmd, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env }
  });
}

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

async function readModuleVersion(name) {
  const json = await readFile(
    path.join(root, "node_modules", name, "package.json"),
    "utf-8"
  );
  return JSON.parse(json).version;
}

try {
  execSync("7z i", { stdio: "ignore" });
} catch {
  fail("`7z` is required (Debian: apt install 7zip).");
}

// 1. JS bundles for the main process & renderer
if (!args.skipJs) exec("npm run release -- --rebuild");
const electronJs = await readFile(path.join(root, "build", "electron.js"));
if (electronJs.includes("nodeWrap"))
  fail(
    "build/electron.js contains un-transformed lingui macros. Was it built on Windows ARM64?"
  );

// 2. sqlite extensions for win32-arm64
exec(
  "npm i --no-save --os win32 --cpu arm64 sqlite-better-trigram sqlite3-fts5-html"
);

// 3. better-sqlite3 binary from the official release
const installerPath = path.join(cacheDir, "notesnook_win_arm64.exe");
const appDir = path.join(cacheDir, "app");
if (!existsSync(appDir)) {
  await mkdir(cacheDir, { recursive: true });
  const url = `https://github.com/streetwriters/notesnook/releases/download/${release}/notesnook_win_arm64.exe`;
  console.log("> downloading", url);
  const response = await fetch(url);
  if (!response.ok) fail(`Failed to download ${url}: ${response.status}`);
  await writeFile(installerPath, Buffer.from(await response.arrayBuffer()));
  // single quotes: `$PLUGINSDIR` is a literal folder name in the installer
  exec(`7z x -y -o"${cacheDir}" "${installerPath}" '$PLUGINSDIR/app-arm64.7z'`);
  exec(
    `7z x -y -o"${appDir}" '${path.join(
      cacheDir,
      "$PLUGINSDIR",
      "app-arm64.7z"
    )}'`
  );
}

const asar = require("@electron/asar");
const officialAsar = path.join(appDir, "resources", "app.asar");
const officialSqliteVersion = JSON.parse(
  asar
    .extractFile(officialAsar, `node_modules/${SQLITE_MODULE}/package.json`)
    .toString()
).version;
const officialElectronVersion = (
  await readFile(path.join(appDir, "Notesnook.exe"))
)
  .toString("latin1")
  .match(/Electron\/(\d+\.\d+\.\d+)/)?.[1];
const localSqliteVersion = await readModuleVersion(SQLITE_MODULE);
const localElectronVersion = await readModuleVersion("electron");
if (
  officialSqliteVersion !== localSqliteVersion ||
  officialElectronVersion !== localElectronVersion
)
  fail(
    `Release ${release} uses Electron ${officialElectronVersion} & ${SQLITE_MODULE} ${officialSqliteVersion} ` +
      `but this checkout has Electron ${localElectronVersion} & ${SQLITE_MODULE} ${localSqliteVersion}. ` +
      `Pass --release=<tag> of a matching release.`
  );

const localBinary = path.join(
  root,
  "node_modules",
  SQLITE_MODULE,
  SQLITE_BINARY
);
await mkdir(path.dirname(localBinary), { recursive: true });
await copyFile(
  path.join(
    appDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    SQLITE_MODULE,
    SQLITE_BINARY
  ),
  localBinary
);

// 4. package
for (const target of targets) {
  exec(
    [
      "npx electron-builder --config=electron-builder.config.js",
      `--win ${target} --arm64 --publish never`,
      "--c.npmRebuild=false",
      `--c.extraMetadata.productName="${productName}"`
    ].join(" "),
    root,
    {
      NOTESNOOK_STAGING: "true",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      NN_PRODUCT_NAME: productName,
      NN_APP_ID: appId
    }
  );
}

console.log(
  `\nDone. Outputs are in ${path.join(
    root,
    "output"
  )} (unsigned, auto-updates are disabled in the portable build).`
);
