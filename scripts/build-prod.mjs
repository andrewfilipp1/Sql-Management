// Production bundle of the Electron main/preload: no source maps in the packaged app.
// Start clean so maps left by a dev build are not packaged either.
import fs from 'node:fs';

process.env.NODE_ENV = 'production';
fs.rmSync(new URL('../dist-electron', import.meta.url), { recursive: true, force: true });
const { build } = await import('./electron-build.mjs');
await build();
