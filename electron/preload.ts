import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNEL, type ApiMethod, type Bridge } from '../shared/ipc.ts';

// The renderer only ever sees this narrow bridge — no Node.js, no raw ipcRenderer.
const bridge: Bridge = {
  invoke: (method: ApiMethod, ...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNEL, method, ...args),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('schemascope', bridge);
