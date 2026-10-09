// Dev loop: Vite (renderer, with HMR) + esbuild watch (main/preload) + auto-restarting Electron.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { createServer } from 'vite';
import { options } from './electron-build.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron'); // resolves to the platform's Electron binary

const vite = await createServer({ configFile: 'vite.config.ts' });
await vite.listen();
const url = vite.resolvedUrls.local[0];
vite.printUrls();

let child = null;
let restarting = false;
function startElectron() {
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, SCHEMASCOPE_DEV_URL: url },
  });
  child.on('exit', () => {
    if (!restarting) shutdown();
  });
}
function restartElectron() {
  if (!child) return startElectron();
  restarting = true;
  child.once('exit', () => {
    restarting = false;
    startElectron();
  });
  child.kill();
}

const ctx = await esbuild.context({
  ...options,
  plugins: [{ name: 'restart', setup: (b) => b.onEnd((r) => !r.errors.length && restartElectron()) }],
});
await ctx.watch();

async function shutdown() {
  await ctx.dispose();
  await vite.close();
  process.exit(0);
}
process.on('SIGINT', () => {
  child?.kill();
  void shutdown();
});
