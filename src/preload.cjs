const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('draftmeter', {
    platform: process.platform,
    onSnapshot: cb => ipcRenderer.on('snapshot', (ev, snap) => cb(snap)),
    onConfig: cb => ipcRenderer.on('config', (ev, cfg) => cb(cfg)),
    setup: {
        get: () => ipcRenderer.invoke('setup:get'),
        login: (username, password) => ipcRenderer.invoke('setup:login', {username, password}),
        search: query => ipcRenderer.invoke('setup:search', query),
        save: (athleteId, athleteName) => ipcRenderer.invoke('setup:save', {athleteId, athleteName}),
        help: () => ipcRenderer.invoke('setup:help'),
    },
});
