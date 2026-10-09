import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNEL, type ApiMethod, type Bridge } from '../shared/ipc.ts';
import { UPDATE_EVENT, type UpdateState } from '../shared/update.ts';

// The renderer only ever sees this narrow bridge — no Node.js, no raw ipcRenderer.
const bridge: Bridge = {
  invoke: (method: ApiMethod, ...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNEL, method, ...args),
  onUpdate: (cb: (state: UpdateState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: UpdateState) => cb(state);
    ipcRenderer.on(UPDATE_EVENT, listener);
    return () => void ipcRenderer.removeListener(UPDATE_EVENT, listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('schemascope', bridge);
