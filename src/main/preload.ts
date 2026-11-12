import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppState } from "../shared/types";
contextBridge.exposeInMainWorld("senmuse", {
  invoke: async (command: string, input?: unknown) => {
    const response = await ipcRenderer.invoke(
      "senmuse:command",
      command,
      input ?? {},
    );
    if (!response.ok) throw new Error(response.error);
    return response.data;
  },
  onState: (callback: (state: AppState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) =>
      callback(state);
    ipcRenderer.on("senmuse:state", listener);
    return () => ipcRenderer.removeListener("senmuse:state", listener);
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform,
});
