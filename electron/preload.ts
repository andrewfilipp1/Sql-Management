import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNEL, type ApiMethod, type Bridge } from '../shared/ipc.ts';
import { UPDATE_EVENT, type UpdateState } from '../shared/update.ts';
import { LOCAL_SERVER_EVENT, type LocalServerState } from '../shared/localServer.ts';

// The renderer only ever sees this narrow bridge — no Node.js, no raw ipcRenderer.
const bridge: Bridge = {
  invoke: (method: ApiMethod, ...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNEL, method, ...args),
  onUpdate: (cb: (state: UpdateState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: UpdateState) => cb(state);
    ipcRenderer.on(UPDATE_EVENT, listener);
    return () => void ipcRenderer.removeListener(UPDATE_EVENT, listener);
  },
  onLocalServer: (cb: (state: LocalServerState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: LocalServerState) => cb(state);
    ipcRenderer.on(LOCAL_SERVER_EVENT, listener);
    return () => void ipcRenderer.removeListener(LOCAL_SERVER_EVENT, listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('schemascope', bridge);
