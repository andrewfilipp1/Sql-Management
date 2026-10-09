// Bundles the Electron main + preload scripts (and the core database layer) to CommonJS.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Runtime dependencies (native modules, DB drivers) stay in node_modules.
const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];

export const options = {
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external,
  logLevel: 'info',
};

export function build() {
  return esbuild.build({ ...options, sourcemap: process.env.NODE_ENV !== 'production' });
}

// Run directly: `node scripts/electron-build.mjs`
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await build();
}
