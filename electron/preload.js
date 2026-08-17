const { contextBridge, ipcRenderer } = require('electron');
const { coreWorkbenchBridge } = require('./preload-bridge');

contextBridge.exposeInMainWorld('workbench', coreWorkbenchBridge(ipcRenderer));
