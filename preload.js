const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (id) => ipcRenderer.send('capture:select-source', id),

  recordingStarted: () => ipcRenderer.send('recording:started'),
  recordingStopped: () => ipcRenderer.send('recording:stopped'),
  onStopRequested: (cb) => ipcRenderer.on('recording:stop-requested', cb),
  saveRecording: (arrayBuffer) => ipcRenderer.invoke('recording:save', arrayBuffer),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),

  // overlay
  overlayStop: () => ipcRenderer.send('overlay:stop-clicked'),

  listLibrary: () => ipcRenderer.invoke('library:list'),
  deleteRecording: (p) => ipcRenderer.invoke('library:delete', p),
  openFolder: () => ipcRenderer.invoke('library:open-folder'),
  reveal: (p) => ipcRenderer.invoke('library:reveal', p),
  getDuration: (p) => ipcRenderer.invoke('media:duration', p),

  exportRun: (opts) => ipcRenderer.invoke('export:run', opts),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, data) => cb(data))
});
