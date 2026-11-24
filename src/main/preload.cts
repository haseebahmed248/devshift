import { contextBridge, ipcRenderer } from 'electron'
import type { DevShiftApi } from '../shared/contracts.js'

const api: DevShiftApi = {
  dashboard: refresh => ipcRenderer.invoke('devshift:dashboard', refresh),
  review: target => ipcRenderer.invoke('devshift:review', target),
  execute: (token, skip) => ipcRenderer.invoke('devshift:execute', token, skip),
  approve: (id, approved) => ipcRenderer.invoke('devshift:approve', id, approved),
  preferences: settings => ipcRenderer.invoke('devshift:preferences', settings),
  pickFile: kind => ipcRenderer.invoke('devshift:pick-file', kind),
  registerNode: data => ipcRenderer.invoke('devshift:register-node', data),
  launchNode: id => ipcRenderer.invoke('devshift:launch-node', id),
  removeNode: id => ipcRenderer.invoke('devshift:remove-node', id),
  quit: () => ipcRenderer.invoke('devshift:quit'),
  onScanDue: listener => {
    const wrapped = () => listener()
    ipcRenderer.on('devshift:scan-due', wrapped)
    return () => { ipcRenderer.off('devshift:scan-due', wrapped) }
  },
  onPerformance: listener => {
    const wrapped = (_: unknown, samples: Parameters<typeof listener>[0]) => listener(samples)
    ipcRenderer.on('devshift:performance', wrapped)
    return () => { ipcRenderer.off('devshift:performance', wrapped) }
  },
  onProgress: listener => {
    const wrapped = (_: unknown, state: Parameters<typeof listener>[0]) => listener(state)
    ipcRenderer.on('devshift:progress', wrapped)
    return () => { ipcRenderer.off('devshift:progress', wrapped) }
  },
  onReview: listener => {
    const wrapped = (_: unknown, target: Parameters<typeof listener>[0]) => listener(target)
    ipcRenderer.on('devshift:tray-review', wrapped)
    return () => { ipcRenderer.off('devshift:tray-review', wrapped) }
  },
}

contextBridge.exposeInMainWorld('devshift', api)
