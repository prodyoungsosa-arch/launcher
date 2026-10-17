'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  boot: () => ipcRenderer.invoke('app:boot'),
  images: () => ipcRenderer.invoke('app:images'),
  status: () => ipcRenderer.invoke('server:status'),
  play: (opts) => ipcRenderer.invoke('game:play', opts || {}),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),

  login: (creds) => ipcRenderer.invoke('auth:login', creds),
  register: (creds) => ipcRenderer.invoke('auth:register', creds),
  logout: () => ipcRenderer.invoke('auth:logout'),
  me: () => ipcRenderer.invoke('auth:me'),

  getAnnouncements: () => ipcRenderer.invoke('announcements:list'),
  createAnnouncement: (data) => ipcRenderer.invoke('announcements:create', data),
  updateAnnouncement: (data) => ipcRenderer.invoke('announcements:update', data),
  deleteAnnouncement: (id) => ipcRenderer.invoke('announcements:delete', { id }),
  reactAnnouncement: (id, reaction) => ipcRenderer.invoke('announcements:react', { id, reaction }),
  getComments: (id) => ipcRenderer.invoke('announcements:comments', { id }),
  postComment: (id, content, parentId) =>
    ipcRenderer.invoke('announcements:comment', { id, content, parentId }),
  updateComment: (id, content) => ipcRenderer.invoke('announcements:commentUpdate', { id, content }),
  deleteComment: (id) => ipcRenderer.invoke('announcements:commentDelete', { id }),
  pickMedia: (kind) => ipcRenderer.invoke('media:pick', { kind }),
  updateProfile: (data) => ipcRenderer.invoke('profile:update', data),
  setAvatar: () => ipcRenderer.invoke('profile:setAvatar'),

  // Tienda
  listPacks: () => ipcRenderer.invoke('store:list'),
  createPack: (data) => ipcRenderer.invoke('store:create', data),
  updatePack: (data) => ipcRenderer.invoke('store:update', data),
  deletePack: (id) => ipcRenderer.invoke('store:delete', { id }),

  // Tickets
  listTickets: () => ipcRenderer.invoke('tickets:list'),
  createTicket: (data) => ipcRenderer.invoke('tickets:create', data),
  claimTicket: (id) => ipcRenderer.invoke('tickets:claim', { id }),
  closeTicket: (id) => ipcRenderer.invoke('tickets:close', { id }),
  getTicketMessages: (id) => ipcRenderer.invoke('tickets:messages', { id }),
  sendTicketMessage: (data) => ipcRenderer.invoke('tickets:sendMessage', data),
  pickTicketMedia: () => ipcRenderer.invoke('tickets:pickMedia'),

  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
});
