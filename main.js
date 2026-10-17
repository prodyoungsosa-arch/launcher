'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const ASSETS_DIR = path.join(ROOT, 'assets');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const IMG_RE = /^launcher_img(\d+)\.(png|jpe?g|webp)$/i;
const SESSION_TOKEN_BYTES = 32;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'annmedia',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

const DEFAULT_SETTINGS = {
  launchMode: 'dzsa',
  playerName: '',
  extraParams: '',
  minimizeOnPlay: true,
  theme: 'dark',
  accentColor: '#2563eb',
  lastAnnouncementRead: 0,
};

let config = null;
let settings = { ...DEFAULT_SETTINGS };
let win = null;
/** @type {{ token: string, userId: number, expiresAt: number } | null} */
let session = null;

const dbPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'malvinas',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 5000,
});

/* ───────── helpers xd ───────── */

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function sessionPath() {
  return path.join(app.getPath('userData'), 'session.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return sanitizeSettings(raw, { ...DEFAULT_SETTINGS });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('No se pudieron guardar los ajustes:', err);
  }
}

function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
    if (!raw || !raw.token || !raw.userId || !raw.expiresAt) return null;
    if (Date.now() > Number(raw.expiresAt)) return null;
    return {
      token: String(raw.token),
      userId: Number(raw.userId),
      expiresAt: Number(raw.expiresAt),
    };
  } catch {
    return null;
  }
}

function persistSession(s) {
  try {
    fs.mkdirSync(path.dirname(sessionPath()), { recursive: true });
    if (!s) {
      try {
        fs.unlinkSync(sessionPath());
      } catch {}
      return;
    }
    fs.writeFileSync(sessionPath(), JSON.stringify(s, null, 2));
  } catch (err) {
    console.error('No se pudo guardar la sesión:', err);
  }
}

function sanitizeSettings(input = {}, base = settings) {
  const out = { ...base };
  if (['dzsa', 'steam'].includes(input.launchMode)) out.launchMode = input.launchMode;
  if (['dark', 'light'].includes(input.theme)) out.theme = input.theme;
  if (typeof input.accentColor === 'string') {
    const hex = input.accentColor.trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) out.accentColor = hex.toLowerCase();
  }
  if (input.lastAnnouncementRead != null) {
    const n = Number(input.lastAnnouncementRead);
    if (Number.isFinite(n) && n >= 0) out.lastAnnouncementRead = n;
  }
  if (typeof input.playerName === 'string') {
    out.playerName = input.playerName.replace(/[^\w\-. ]/g, '').trim().slice(0, 32);
  }
  if (typeof input.extraParams === 'string') {
    out.extraParams = input.extraParams.replace(/[\u0000-\u001f"`]/g, '').trim().slice(0, 240);
  }
  if (typeof input.minimizeOnPlay === 'boolean') out.minimizeOnPlay = input.minimizeOnPlay;
  return out;
}

function publicUser(row) {
  if (!row) return null;
  let avatar = row.avatar_url || null;
  if (avatar && !/^https?:\/\//i.test(avatar) && !avatar.startsWith('annmedia://')) {
    avatar = `annmedia://${path.basename(String(avatar).replace(/\\/g, '/'))}`;
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role || 'user',
    displayName: row.display_name || row.username,
    avatarUrl: avatar,
    bio: row.bio || '',
    isStaff: ['admin', 'dev'].includes(row.role),
  };
}

function newToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

async function userById(id) {
  const [rows] = await dbPool.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function requireUser() {
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    session = null;
    persistSession(null);
    return null;
  }
  const user = await userById(session.userId);
  if (!user) {
    session = null;
    persistSession(null);
    return null;
  }
  return user;
}

async function requireStaff() {
  const user = await requireUser();
  if (!user || !['admin', 'dev'].includes(user.role)) return null;
  return user;
}

function parseSections(input) {
  if (Array.isArray(input)) {
    return input
      .map((s) => String(s).trim().toUpperCase().slice(0, 32))
      .filter(Boolean)
      .slice(0, 8);
  }
  if (typeof input === 'string' && input.trim()) {
    return input
      .split(/[,|]/)
      .map((s) => s.trim().toUpperCase().slice(0, 32))
      .filter(Boolean)
      .slice(0, 8);
  }
  return [];
}

function mediaDir() {
  return path.join(app.getPath('userData'), 'announcement-media');
}

function ensureMediaDir() {
  fs.mkdirSync(mediaDir(), { recursive: true });
}

/** Convierte valor de DB a URL usable en el renderer */
function toClientMediaUrl(stored) {
  if (!stored) return null;
  const s = String(stored);
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('annmedia://')) return s;
  const key = path.basename(s.replace(/\\/g, '/'));
  return `annmedia://${key}`;
}

function parseMedia(input = {}) {
  const type = ['none', 'image', 'video', 'link', 'file'].includes(input.mediaType)
    ? input.mediaType
    : 'none';
  let url = typeof input.mediaUrl === 'string' ? input.mediaUrl.trim().slice(0, 1024) : null;
  const name = typeof input.mediaName === 'string' ? input.mediaName.trim().slice(0, 255) : null;
  if (type === 'none' || !url) return { media_type: 'none', media_url: null, media_name: null };

  // Archivo local subido (solo el nombre de archivo)
  if (url.startsWith('annmedia://')) {
    return { media_type: type, media_url: path.basename(url.replace('annmedia://', '')), media_name: name };
  }
  if (!/^https?:\/\//i.test(url) && !url.includes('/') && !url.includes('\\')) {
    return { media_type: type, media_url: path.basename(url), media_name: name };
  }

  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) {
      return { media_type: 'none', media_url: null, media_name: null };
    }
    return { media_type: type, media_url: u.toString(), media_name: name };
  } catch {
    return { media_type: 'none', media_url: null, media_name: null };
  }
}

function sanitizeEmoji(raw) {
  const s = String(raw || '').trim().slice(0, 16);
  if (!s) return null;
  // Un emoji / secuencia corta, sin espacios
  if (/\s/.test(s)) return null;
  return s;
}

function mapAnnouncement(row, extras = {}) {
  let sections = [];
  try {
    if (typeof row.sections === 'string') sections = JSON.parse(row.sections || '[]');
    else if (Array.isArray(row.sections)) sections = row.sections;
  } catch {
    sections = [];
  }
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    sections,
    mediaType: row.media_type || 'none',
    mediaUrl: toClientMediaUrl(row.media_url),
    mediaName: row.media_name || null,
    pinned: !!row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    author: {
      id: row.author_id,
      username: row.author_username || row.username,
      displayName: row.author_display || row.display_name || row.author_username,
      role: row.author_role || 'user',
      avatarUrl: toClientMediaUrl(row.author_avatar || row.avatar_url) || null,
    },
    reactions: extras.reactions || {},
    myReactions: extras.myReactions || [],
    commentCount: extras.commentCount ?? row.comment_count ?? 0,
    canEdit: extras.canEdit ?? false,
  };
}

/* ───────── status / launch (original) ───────── */

function listImages() {
  try {
    return fs
      .readdirSync(ASSETS_DIR)
      .map((name) => {
        const m = IMG_RE.exec(name);
        return m ? { name, n: parseInt(m[1], 10) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.n - b.n)
      .map((x) => x.name);
  } catch {
    return [];
  }
}

function parseA2SInfo(buf) {
  let o = 5;
  const readStr = () => {
    const end = buf.indexOf(0, o);
    if (end === -1) throw new Error('respuesta A2S inválida');
    const s = buf.toString('utf8', o, end);
    o = end + 1;
    return s;
  };
  o += 1;
  const name = readStr();
  const map = readStr();
  readStr();
  readStr();
  o += 2;
  const players = buf[o++];
  const maxPlayers = buf[o++];
  return { name, map, players, maxPlayers };
}

function queryA2S(host, port, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    let sentAt = Date.now();

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {}
      err ? reject(err) : resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    const base = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
      Buffer.from('Source Engine Query\0', 'latin1'),
    ]);

    sock.on('error', (e) => finish(e));
    sock.on('message', (msg) => {
      if (msg.length < 5) return;
      const type = msg[4];
      if (type === 0x41 && msg.length >= 9) {
        sentAt = Date.now();
        sock.send(Buffer.concat([base, msg.subarray(5, 9)]), port, host);
      } else if (type === 0x49) {
        try {
          const info = parseA2SInfo(msg);
          info.ping = Date.now() - sentAt;
          finish(null, info);
        } catch (e) {
          finish(e);
        }
      }
    });

    sock.send(base, port, host, (err) => err && finish(err));
  });
}

async function queryDzsaApi(host, port, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://dayzsalauncher.com/api/v1/query/${host}/${port}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const r = json.result || json;
    if (typeof r.players !== 'number') throw new Error('respuesta inesperada');
    return {
      name: r.name,
      players: r.players,
      maxPlayers: r.maxPlayers ?? r.max_players ?? 0,
      ping: null,
    };
  } finally {
    clearTimeout(t);
  }
}

let statusCache = { ts: 0, data: null };

function getMaps() {
  const s = config.server || {};
  if (Array.isArray(s.maps) && s.maps.length) {
    return s.maps.map((m) => ({
      id: m.id || String(m.gamePort),
      name: m.name || m.id || 'Mapa',
      gamePort: Number(m.gamePort) || Number(s.gamePort) || 2302,
      queryPort: Number(m.queryPort) || Number(s.queryPort) || 27016,
      joinUrl:
        m.joinUrl ||
        `https://join.dayzsalauncher.com/${s.ip}:${m.gamePort || s.gamePort}`,
      description: m.description || '',
      ip: s.ip,
    }));
  }
  return [
    {
      id: 'default',
      name: s.map || 'Chernarus+',
      gamePort: Number(s.gamePort) || 2302,
      queryPort: Number(s.queryPort) || 27016,
      joinUrl: s.joinUrl,
      description: '',
      ip: s.ip,
    },
  ];
}

async function queryOneMap(map) {
  let info = null;
  try {
    info = await queryA2S(map.ip, map.queryPort);
  } catch {
    try {
      info = await queryDzsaApi(map.ip, map.queryPort);
    } catch {}
  }
  if (!info) {
    return {
      id: map.id,
      name: map.name,
      online: false,
      players: 0,
      maxPlayers: 0,
      map: map.name,
      ip: map.ip,
      gamePort: map.gamePort,
      joinUrl: map.joinUrl,
      description: map.description || '',
      ping: null,
    };
  }
  return {
    id: map.id,
    name: map.name,
    online: true,
    players: info.players,
    maxPlayers: info.maxPlayers,
    map: info.map || map.name,
    ip: map.ip,
    gamePort: map.gamePort,
    joinUrl: map.joinUrl,
    description: map.description || '',
    ping: info.ping || null,
  };
}

async function getStatus() {
  const maps = getMaps();
  const results = await Promise.all(maps.map((m) => queryOneMap(m)));
  const anyOnline = results.some((r) => r.online);
  const players = results.reduce((a, r) => a + (Number(r.players) || 0), 0);
  const maxPlayers = results.reduce((a, r) => a + (Number(r.maxPlayers) || 0), 0);
  return {
    online: anyOnline,
    players,
    maxPlayers,
    ping: results.find((r) => r.ping)?.ping || null,
    name: config.server?.name,
    ts: Date.now(),
    maps: results,
  };
}

function allowedHosts() {
  const hosts = new Set(['discord.gg', 'discord.com', 'join.dayzsalauncher.com', 'dayzsalauncher.com']);
  for (const key of ['joinUrl', 'discordUrl']) {
    try {
      hosts.add(new URL(config.server[key]).hostname);
    } catch {}
  }
  return hosts;
}

function openSafe(url, { anyHttps = false } = {}) {
  try {
    const u = new URL(url);
    if (u.protocol === 'steam:') {
      shell.openExternal(u.toString());
      return true;
    }
    if (u.protocol !== 'https:') return false;
    if (anyHttps || allowedHosts().has(u.hostname)) {
      shell.openExternal(u.toString());
      return true;
    }
  } catch {}
  return false;
}

function buildLaunchArgs() {
  const s = config.server;
  const args = [`-connect=${s.ip}`, `-port=${s.gamePort}`, '-nolauncher'];
  if (settings.playerName) args.push(`-name=${settings.playerName}`);
  if (Array.isArray(s.mods) && s.mods.length) args.push(`-mod=${s.mods.join(';')}`);
  if (settings.extraParams) args.push(settings.extraParams);
  return args;
}

async function launchGame(opts = {}) {
  try {
    const maps = await getMaps();
    const mapId = opts.mapId || null;
    const selected = (mapId && maps.find((m) => m.id === mapId)) || maps[0];
    if (!selected) throw new Error('No hay mapas configurados');

    if (settings.launchMode === 'steam') {
      const appId = Number(config.server.steamAppId) || 221100;
      const args = [`-connect=${selected.ip}`, `-port=${selected.gamePort}`, '-nolauncher'];
      if (settings.playerName) args.push(`-name=${settings.playerName}`);
      if (settings.extraParams) args.push(...String(settings.extraParams).split(/\s+/).filter(Boolean));
      // Steam connect via +connect is more reliable with steam://
      const steamUrl = `steam://run/${appId}//-connect=${selected.ip} -port=${selected.gamePort} -nolauncher/`;
      if (!openSafe(steamUrl) && !openSafe(selected.joinUrl)) {
        throw new Error('No se pudo abrir Steam / enlace del servidor');
      }
    } else {
      if (!openSafe(selected.joinUrl)) throw new Error('URL de conexión inválida');
    }
    return { ok: true, mode: settings.launchMode, map: selected.name, mapId: selected.id };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/* ───────── window ───────── */

function createWindow() {
  const iconPath = path.join(ASSETS_DIR, 'icon.png');
  win = new BrowserWindow({
    width: 1200,
    height: 700,
    minWidth: 1000,
    minHeight: 620,
    resizable: true,
    frame: false,
    show: false,
    backgroundColor: '#06080d',
    title: config.server.name,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
  });
}

/* ───────── IPC ───────── */

function registerIpc() {
  ipcMain.handle('app:boot', async () => {
    let user = null;
    try {
      user = publicUser(await requireUser());
    } catch (err) {
      console.error('boot session:', err);
    }
    return {
      config,
      settings,
      version: app.getVersion(),
      user,
      authenticated: !!user,
    };
  });

  ipcMain.handle('app:images', () => listImages());

  /* Auth */
  ipcMain.handle('auth:login', async (_e, { username, password }) => {
    try {
      const u = String(username || '').trim().slice(0, 120);
      const p = String(password || '');
      if (!u || !p) return { ok: false, error: 'Completá usuario y contraseña' };

      const [rows] = await dbPool.execute(
        'SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1',
        [u, u]
      );
      if (rows.length === 0) return { ok: false, error: 'Usuario no encontrado' };

      const row = rows[0];
      const match = await bcrypt.compare(p, row.password);
      if (!match) return { ok: false, error: 'Contraseña incorrecta' };

      session = {
        token: newToken(),
        userId: row.id,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 días
      };
      persistSession(session);

      return { ok: true, user: publicUser(row) };
    } catch (err) {
      console.error('auth:login', err);
      const detail = err && err.code ? ` [${err.code}]` : '';
      return {
        ok: false,
        error: `Error de conexión con la base de datos (malvinas)${detail}. ¿MySQL está corriendo?`,
      };
    }
  });

  ipcMain.handle('auth:register', async (_e, { username, email, password }) => {
    try {
      const uname = String(username || '')
        .trim()
        .replace(/[^\w.\-]/g, '')
        .slice(0, 32);
      const mail = String(email || '')
        .trim()
        .toLowerCase()
        .slice(0, 120);
      const pass = String(password || '');

      if (uname.length < 3) return { ok: false, error: 'Usuario: mínimo 3 caracteres' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { ok: false, error: 'Email inválido' };
      if (pass.length < 6) return { ok: false, error: 'Contraseña: mínimo 6 caracteres' };

      const [existing] = await dbPool.execute(
        'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1',
        [uname, mail]
      );
      if (existing.length > 0) return { ok: false, error: 'El usuario o email ya existe' };

      const hashed = await bcrypt.hash(pass, 10);
      const [result] = await dbPool.execute(
        'INSERT INTO users (username, email, password, role, display_name) VALUES (?, ?, ?, ?, ?)',
        [uname, mail, hashed, 'user', uname]
      );

      const user = {
        id: result.insertId,
        username: uname,
        email: mail,
        role: 'user',
        display_name: uname,
        avatar_url: null,
      };

      session = {
        token: newToken(),
        userId: user.id,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      };
      persistSession(session);

      return { ok: true, user: publicUser(user), message: 'Cuenta creada' };
    } catch (err) {
      console.error('auth:register', err);
      const detail = err && err.code ? ` [${err.code}]` : '';
      const msg =
        err && err.code === 'ER_BAD_FIELD_ERROR'
          ? 'Falta alguna columna en la tabla users (role, etc.). Ejecutá el schema.sql actualizado.'
          : `Error al registrar en la base de datos${detail}`;
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    session = null;
    persistSession(null);
    return { ok: true };
  });

  ipcMain.handle('auth:me', async () => {
    try {
      const user = await requireUser();
      return { ok: !!user, user: publicUser(user) };
    } catch {
      return { ok: false, user: null };
    }
  });

  /* Announcements */
  ipcMain.handle('announcements:list', async () => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión', data: [] };

      const [rows] = await dbPool.execute(
        `SELECT a.*,
                u.username AS author_username,
                u.display_name AS author_display,
                u.role AS author_role,
                u.avatar_url AS author_avatar,
                (SELECT COUNT(*) FROM announcement_comments c WHERE c.announcement_id = a.id) AS comment_count
         FROM announcements a
         JOIN users u ON u.id = a.author_id
         ORDER BY a.pinned DESC, a.created_at DESC
         LIMIT 50`
      );

      const ids = rows.map((r) => r.id);
      let reactionRows = [];
      let myRows = [];
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        const [rr] = await dbPool.execute(
          `SELECT announcement_id, reaction, COUNT(*) AS cnt
           FROM announcement_reactions
           WHERE announcement_id IN (${placeholders})
           GROUP BY announcement_id, reaction`,
          ids
        );
        reactionRows = rr;
        const [mr] = await dbPool.execute(
          `SELECT announcement_id, reaction
           FROM announcement_reactions
           WHERE user_id = ? AND announcement_id IN (${placeholders})`,
          [me.id, ...ids]
        );
        myRows = mr;
      }

      const byAnn = {};
      for (const r of reactionRows) {
        if (!byAnn[r.announcement_id]) byAnn[r.announcement_id] = {};
        byAnn[r.announcement_id][r.reaction] = Number(r.cnt);
      }
      const myByAnn = {};
      for (const r of myRows) {
        if (!myByAnn[r.announcement_id]) myByAnn[r.announcement_id] = [];
        myByAnn[r.announcement_id].push(r.reaction);
      }

      const data = rows.map((row) =>
        mapAnnouncement(row, {
          reactions: byAnn[row.id] || {},
          myReactions: myByAnn[row.id] || [],
          commentCount: Number(row.comment_count) || 0,
          canEdit: me.id === row.author_id || ['admin', 'dev'].includes(me.role),
        })
      );

      return { ok: true, data };
    } catch (err) {
      console.error('announcements:list', err);
      return { ok: false, data: [], error: 'No se pudieron cargar los anuncios' };
    }
  });

  ipcMain.handle('announcements:create', async (_e, payload = {}) => {
    try {
      const me = await requireStaff();
      if (!me) return { ok: false, error: 'Solo administración puede publicar' };

      const title = String(payload.title || '').trim().slice(0, 200);
      const content = String(payload.content || '').trim().slice(0, 8000);
      const category = String(payload.category || 'Novedad').trim().slice(0, 64) || 'Novedad';
      const sections = parseSections(payload.sections);
      const media = parseMedia(payload);
      const pinned = !!payload.pinned;

      if (!title || !content) return { ok: false, error: 'Título y contenido son obligatorios' };

      const [result] = await dbPool.execute(
        `INSERT INTO announcements
          (author_id, title, content, category, sections, media_type, media_url, media_name, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          me.id,
          title,
          content,
          category,
          JSON.stringify(sections),
          media.media_type,
          media.media_url,
          media.media_name,
          pinned ? 1 : 0,
        ]
      );

      return { ok: true, id: result.insertId };
    } catch (err) {
      console.error('announcements:create', err);
      return { ok: false, error: 'No se pudo publicar el anuncio' };
    }
  });

  ipcMain.handle('announcements:update', async (_e, payload = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };

      const id = Number(payload.id);
      if (!id) return { ok: false, error: 'Anuncio inválido' };

      const [rows] = await dbPool.execute('SELECT * FROM announcements WHERE id = ? LIMIT 1', [id]);
      if (!rows.length) return { ok: false, error: 'Anuncio no encontrado' };
      const ann = rows[0];
      const canEdit = ann.author_id === me.id || ['admin', 'dev'].includes(me.role);
      if (!canEdit) return { ok: false, error: 'No tenés permiso para editar este anuncio' };

      const title = String(payload.title ?? ann.title).trim().slice(0, 200);
      const content = String(payload.content ?? ann.content).trim().slice(0, 8000);
      const category = String(payload.category ?? ann.category).trim().slice(0, 64) || 'Novedad';
      const sections =
        payload.sections !== undefined ? parseSections(payload.sections) : (() => {
          try {
            return JSON.parse(ann.sections || '[]');
          } catch {
            return [];
          }
        })();
      const media =
        payload.mediaType !== undefined || payload.mediaUrl !== undefined
          ? parseMedia(payload)
          : {
              media_type: ann.media_type,
              media_url: ann.media_url,
              media_name: ann.media_name,
            };
      const pinned =
        payload.pinned !== undefined
          ? !!payload.pinned
          : !!ann.pinned;

      if (!title || !content) return { ok: false, error: 'Título y contenido son obligatorios' };

      await dbPool.execute(
        `UPDATE announcements SET
           title = ?, content = ?, category = ?, sections = ?,
           media_type = ?, media_url = ?, media_name = ?, pinned = ?
         WHERE id = ?`,
        [
          title,
          content,
          category,
          JSON.stringify(sections),
          media.media_type,
          media.media_url,
          media.media_name,
          pinned ? 1 : 0,
          id,
        ]
      );

      return { ok: true };
    } catch (err) {
      console.error('announcements:update', err);
      return { ok: false, error: 'No se pudo actualizar el anuncio' };
    }
  });

  ipcMain.handle('announcements:delete', async (_e, { id } = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };
      const annId = Number(id);
      if (!annId) return { ok: false, error: 'Anuncio inválido' };

      const [rows] = await dbPool.execute('SELECT author_id FROM announcements WHERE id = ?', [annId]);
      if (!rows.length) return { ok: false, error: 'Anuncio no encontrado' };
      const can = rows[0].author_id === me.id || ['admin', 'dev'].includes(me.role);
      if (!can) return { ok: false, error: 'Sin permiso' };

      await dbPool.execute('DELETE FROM announcements WHERE id = ?', [annId]);
      return { ok: true };
    } catch (err) {
      console.error('announcements:delete', err);
      return { ok: false, error: 'No se pudo eliminar' };
    }
  });

  ipcMain.handle('media:pick', async (_e, { kind } = {}) => {
    try {
      const me = await requireStaff();
      if (!me) return { ok: false, error: 'Solo staff puede subir archivos' };
      const isVideo = kind === 'video';
      const result = await dialog.showOpenDialog(win, {
        title: isVideo ? 'Elegir video' : 'Elegir imagen',
        properties: ['openFile'],
        filters: isVideo
          ? [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi'] }]
          : [{ name: 'Imagen', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      });
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, cancelled: true };

      const src = result.filePaths[0];
      const ext = path.extname(src).toLowerCase() || (isVideo ? '.mp4' : '.png');
      const key = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      ensureMediaDir();
      fs.copyFileSync(src, path.join(mediaDir(), key));

      return {
        ok: true,
        mediaType: isVideo ? 'video' : 'image',
        mediaUrl: key,
        mediaName: path.basename(src),
        clientUrl: `annmedia://${key}`,
      };
    } catch (err) {
      console.error('media:pick', err);
      return { ok: false, error: 'No se pudo subir el archivo' };
    }
  });

  ipcMain.handle('announcements:react', async (_e, { id, reaction } = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };
      const annId = Number(id);
      const emoji = sanitizeEmoji(reaction);
      if (!annId || !emoji) return { ok: false, error: 'Reacción inválida' };

      // Una reacción por usuario por anuncio: mismo emoji la quita, otro la cambia
      const [existing] = await dbPool.execute(
        'SELECT id, reaction FROM announcement_reactions WHERE announcement_id = ? AND user_id = ? LIMIT 1',
        [annId, me.id]
      );

      if (existing.length) {
        if (existing[0].reaction === emoji) {
          await dbPool.execute('DELETE FROM announcement_reactions WHERE id = ?', [existing[0].id]);
          return { ok: true, toggled: false, reaction: null };
        }
        await dbPool.execute('UPDATE announcement_reactions SET reaction = ? WHERE id = ?', [
          emoji,
          existing[0].id,
        ]);
        return { ok: true, toggled: true, reaction: emoji };
      }

      await dbPool.execute(
        'INSERT INTO announcement_reactions (announcement_id, user_id, reaction) VALUES (?, ?, ?)',
        [annId, me.id, emoji]
      );
      return { ok: true, toggled: true, reaction: emoji };
    } catch (err) {
      console.error('announcements:react', err);
      return {
        ok: false,
        error:
          err && err.code === 'ER_DATA_TOO_LONG'
            ? 'Ejecutá sql/migrate-social.sql para permitir emojis libres'
            : 'No se pudo reaccionar',
      };
    }
  });

  ipcMain.handle('announcements:comments', async (_e, { id } = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión', data: [] };
      const annId = Number(id);
      if (!annId) return { ok: false, data: [] };

      let rows;
      try {
        const [r] = await dbPool.execute(
          `SELECT c.*, u.username, u.display_name, u.role, u.avatar_url
           FROM announcement_comments c
           JOIN users u ON u.id = c.user_id
           WHERE c.announcement_id = ?
           ORDER BY c.created_at ASC
           LIMIT 300`,
          [annId]
        );
        rows = r;
      } catch (err) {
        console.error('announcements:comments', err);
        return { ok: false, data: [], error: 'No se pudieron cargar comentarios' };
      }

      return {
        ok: true,
        data: rows.map((r) => ({
          id: r.id,
          content: r.content,
          parentId: r.parent_id != null ? Number(r.parent_id) : null,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          canEdit: r.user_id === me.id,
          canDelete: r.user_id === me.id || ['admin', 'dev'].includes(me.role),
          author: {
            id: r.user_id,
            username: r.username,
            displayName: r.display_name || r.username,
            role: r.role,
            avatarUrl: toClientMediaUrl(r.avatar_url) || null,
          },
        })),
      };
    } catch (err) {
      console.error('announcements:comments', err);
      return { ok: false, data: [], error: 'No se pudieron cargar comentarios' };
    }
  });

  ipcMain.handle('announcements:comment', async (_e, { id, content, parentId } = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };
      const annId = Number(id);
      const text = String(content || '').trim().slice(0, 1000);
      if (!annId || !text) return { ok: false, error: 'Comentario vacío' };

      let parent = parentId != null && parentId !== '' ? Number(parentId) : null;
      if (parent) {
        const [pRows] = await dbPool.execute(
          'SELECT id FROM announcement_comments WHERE id = ? AND announcement_id = ?',
          [parent, annId]
        );
        if (!pRows.length) parent = null;
      }

      try {
        const [result] = await dbPool.execute(
          'INSERT INTO announcement_comments (announcement_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)',
          [annId, me.id, text, parent]
        );
        return { ok: true, id: result.insertId };
      } catch (err) {
        // Sin columna parent_id todavía
        if (err && err.code === 'ER_BAD_FIELD_ERROR') {
          const [result] = await dbPool.execute(
            'INSERT INTO announcement_comments (announcement_id, user_id, content) VALUES (?, ?, ?)',
            [annId, me.id, text]
          );
          return { ok: true, id: result.insertId };
        }
        throw err;
      }
    } catch (err) {
      console.error('announcements:comment', err);
      return { ok: false, error: 'No se pudo comentar' };
    }
  });

  ipcMain.handle('announcements:commentUpdate', async (_e, { id, content } = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };
      const cId = Number(id);
      const text = String(content || '').trim().slice(0, 1000);
      if (!cId || !text) return { ok: false, error: 'Comentario vacío' };

      const [rows] = await dbPool.execute('SELECT * FROM announcement_comments WHERE id = ?', [cId]);
      if (!rows.length) return { ok: false, error: 'No encontrado' };
      if (rows[0].user_id !== me.id) return { ok: false, error: 'Solo podés editar tus comentarios' };

      await dbPool.execute('UPDATE announcement_comments SET content = ? WHERE id = ?', [text, cId]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'No se pudo editar' };
    }
  });

  ipcMain.handle('announcements:commentDelete', async (_e, { id } = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };
      const cId = Number(id);
      const [rows] = await dbPool.execute('SELECT * FROM announcement_comments WHERE id = ?', [cId]);
      if (!rows.length) return { ok: false, error: 'No encontrado' };
      if (rows[0].user_id !== me.id && !['admin', 'dev'].includes(me.role)) {
        return { ok: false, error: 'Sin permiso' };
      }
      // Borra respuestas hijas si existen
      try {
        await dbPool.execute('DELETE FROM announcement_comments WHERE parent_id = ?', [cId]);
      } catch {}
      await dbPool.execute('DELETE FROM announcement_comments WHERE id = ?', [cId]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'No se pudo borrar' };
    }
  });

  ipcMain.handle('server:status', async () => {
    if (statusCache.data && Date.now() - statusCache.ts < 4000) return statusCache.data;
    const data = await getStatus();
    statusCache = { ts: Date.now(), data };
    return data;
  });

  ipcMain.handle('game:play', async (_e, opts = {}) => {
    const me = await requireUser();
    if (!me) return { ok: false, error: 'Iniciá sesión para jugar' };
    return launchGame(opts || {});
  });

  ipcMain.handle('settings:save', (_e, incoming) => {
    settings = sanitizeSettings(incoming, settings);
    persistSettings();
    return settings;
  });

  ipcMain.handle('shell:open', (_e, url) => openSafe(String(url), { anyHttps: true }));

  ipcMain.handle('clipboard:copy', (_e, text) => {
    clipboard.writeText(String(text).slice(0, 500));
    return true;
  });


  /* ───────── Store packs ───────── */

  ipcMain.handle('store:list', async () => {
    try {
      const [rows] = await dbPool.execute(
        `SELECT id, name, description, price, icon, active, created_at, updated_at
         FROM store_packs WHERE active = 1 ORDER BY id ASC`
      );
      return {
        ok: true,
        data: rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description || '',
          price: Number(r.price),
          icon: r.icon || 'shield',
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      };
    } catch (err) {
      console.error('store:list', err);
      return {
        ok: false,
        data: [],
        error:
          err && err.code === 'ER_NO_SUCH_TABLE'
            ? 'Falta la tabla store_packs. Ejecutá sql/migrate-store-tickets.sql'
            : 'No se pudieron cargar los packs',
      };
    }
  });

  ipcMain.handle('store:create', async (_e, payload = {}) => {
    try {
      const me = await requireStaff();
      if (!me) return { ok: false, error: 'Solo staff puede crear packs' };
      const name = String(payload.name || '').trim().slice(0, 120);
      const description = String(payload.description || '').trim().slice(0, 2000);
      const price = Number(payload.price);
      const icon = String(payload.icon || 'shield').trim().slice(0, 32);
      if (!name || !Number.isFinite(price) || price < 0) {
        return { ok: false, error: 'Nombre y precio válidos son obligatorios' };
      }
      const [result] = await dbPool.execute(
        `INSERT INTO store_packs (name, description, price, icon, created_by) VALUES (?, ?, ?, ?, ?)`,
        [name, description, price, icon, me.id]
      );
      return { ok: true, id: result.insertId };
    } catch (err) {
      console.error('store:create', err);
      return { ok: false, error: 'No se pudo crear el pack' };
    }
  });

  ipcMain.handle('store:update', async (_e, payload = {}) => {
    try {
      const me = await requireStaff();
      if (!me) return { ok: false, error: 'Solo staff puede editar packs' };
      const id = Number(payload.id);
      if (!id) return { ok: false, error: 'Pack inválido' };
      const name = String(payload.name || '').trim().slice(0, 120);
      const description = String(payload.description || '').trim().slice(0, 2000);
      const price = Number(payload.price);
      const icon = String(payload.icon || 'shield').trim().slice(0, 32);
      if (!name || !Number.isFinite(price) || price < 0) {
        return { ok: false, error: 'Nombre y precio válidos son obligatorios' };
      }
      const [result] = await dbPool.execute(
        `UPDATE store_packs SET name = ?, description = ?, price = ?, icon = ? WHERE id = ? AND active = 1`,
        [name, description, price, icon, id]
      );
      if (result.affectedRows === 0) return { ok: false, error: 'Pack no encontrado' };
      return { ok: true };
    } catch (err) {
      console.error('store:update', err);
      return { ok: false, error: 'No se pudo actualizar el pack' };
    }
  });

  ipcMain.handle('store:delete', async (_e, { id } = {}) => {
    try {
      const me = await requireStaff();
      if (!me) return { ok: false, error: 'Solo staff puede eliminar packs' };
      const packId = Number(id);
      if (!packId) return { ok: false, error: 'Pack inválido' };
      // soft delete
      const [result] = await dbPool.execute(
        `UPDATE store_packs SET active = 0 WHERE id = ?`,
        [packId]
      );
      if (result.affectedRows === 0) return { ok: false, error: 'Pack no encontrado' };
      return { ok: true };
    } catch (err) {
      console.error('store:delete', err);
      return { ok: false, error: 'No se pudo eliminar el pack' };
    }
  });

  /* ───────── Tickets ───────── */

  function mapTicketRow(r) {
    return {
      id: r.id,
      userId: r.user_id,
      subject: r.subject,
      status: r.status,
      claimedBy: r.claimed_by,
      claimedName: r.claimed_display || r.claimed_username || null,
      authorName: r.author_display || r.author_username || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  ipcMain.handle('tickets:list', async () => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión', data: [] };
      const isStaff = ['admin', 'dev'].includes(me.role);

      let rows;
      if (isStaff) {
        const [r] = await dbPool.execute(
          `SELECT t.*,
                  u.username AS author_username,
                  u.display_name AS author_display,
                  c.username AS claimed_username,
                  c.display_name AS claimed_display
           FROM tickets t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN users c ON c.id = t.claimed_by
           ORDER BY FIELD(t.status, 'Abierto', 'En Proceso', 'Cerrado'), t.updated_at DESC
           LIMIT 200`
        );
        rows = r;
      } else {
        const [r] = await dbPool.execute(
          `SELECT t.*,
                  u.username AS author_username,
                  u.display_name AS author_display,
                  c.username AS claimed_username,
                  c.display_name AS claimed_display
           FROM tickets t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN users c ON c.id = t.claimed_by
           WHERE t.user_id = ?
           ORDER BY t.updated_at DESC
           LIMIT 100`,
          [me.id]
        );
        rows = r;
      }
      return { ok: true, data: rows.map(mapTicketRow) };
    } catch (err) {
      console.error('tickets:list', err);
      return {
        ok: false,
        data: [],
        error:
          err && err.code === 'ER_NO_SUCH_TABLE'
            ? 'Falta la tabla tickets. Ejecutá sql/migrate-store-tickets.sql'
            : 'No se pudieron cargar los tickets',
      };
    }
  });

  ipcMain.handle('tickets:create', async (_e, payload = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };
      const subject = String(payload.subject || '').trim().slice(0, 200);
      const message = String(payload.message || '').trim().slice(0, 2000);
      if (!subject || !message) return { ok: false, error: 'Asunto y mensaje son obligatorios' };

      const [openRows] = await dbPool.execute(
        `SELECT COUNT(*) AS cnt FROM tickets WHERE user_id = ? AND status != 'Cerrado'`,
        [me.id]
      );
      if (Number(openRows[0].cnt) >= 3) {
        return { ok: false, error: 'Máximo 3 tickets abiertos a la vez' };
      }

      const conn = await dbPool.getConnection();
      try {
        await conn.beginTransaction();
        const [result] = await conn.execute(
          `INSERT INTO tickets (user_id, subject, status) VALUES (?, ?, 'Abierto')`,
          [me.id, subject]
        );
        const ticketId = result.insertId;
        await conn.execute(
          `INSERT INTO ticket_messages (ticket_id, user_id, content) VALUES (?, ?, ?)`,
          [ticketId, me.id, message]
        );
        await conn.commit();
        return { ok: true, id: ticketId };
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error('tickets:create', err);
      return { ok: false, error: 'No se pudo crear el ticket' };
    }
  });

  ipcMain.handle('tickets:claim', async (_e, { id } = {}) => {
    try {
      const me = await requireStaff();
      if (!me) return { ok: false, error: 'Solo staff puede reclamar tickets' };
      const ticketId = Number(id);
      if (!ticketId) return { ok: false, error: 'Ticket inválido' };
      const [rows] = await dbPool.execute('SELECT * FROM tickets WHERE id = ? LIMIT 1', [ticketId]);
      if (!rows.length) return { ok: false, error: 'Ticket no encontrado' };
      if (rows[0].status === 'Cerrado') return { ok: false, error: 'El ticket ya está cerrado' };
      await dbPool.execute(
        `UPDATE tickets SET claimed_by = ?, status = 'En Proceso' WHERE id = ?`,
        [me.id, ticketId]
      );
      return { ok: true };
    } catch (err) {
      console.error('tickets:claim', err);
      return { ok: false, error: 'No se pudo reclamar el ticket' };
    }
  });

  ipcMain.handle('tickets:close', async (_e, { id } = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };
      const ticketId = Number(id);
      if (!ticketId) return { ok: false, error: 'Ticket inválido' };
      const [rows] = await dbPool.execute('SELECT * FROM tickets WHERE id = ? LIMIT 1', [ticketId]);
      if (!rows.length) return { ok: false, error: 'Ticket no encontrado' };
      const t = rows[0];
      const isStaff = ['admin', 'dev'].includes(me.role);
      if (!isStaff && t.user_id !== me.id) return { ok: false, error: 'Sin permiso' };
      await dbPool.execute(`UPDATE tickets SET status = 'Cerrado' WHERE id = ?`, [ticketId]);
      return { ok: true };
    } catch (err) {
      console.error('tickets:close', err);
      return { ok: false, error: 'No se pudo cerrar el ticket' };
    }
  });

  ipcMain.handle('tickets:messages', async (_e, { id } = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión', data: [] };
      const ticketId = Number(id);
      if (!ticketId) return { ok: false, data: [] };

      const [tickets] = await dbPool.execute('SELECT * FROM tickets WHERE id = ? LIMIT 1', [ticketId]);
      if (!tickets.length) return { ok: false, error: 'Ticket no encontrado', data: [] };
      const t = tickets[0];
      const isStaff = ['admin', 'dev'].includes(me.role);
      if (!isStaff && t.user_id !== me.id) return { ok: false, error: 'Sin permiso', data: [] };

      const [rows] = await dbPool.execute(
        `SELECT m.*, u.username, u.display_name, u.role, u.avatar_url
         FROM ticket_messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.ticket_id = ?
         ORDER BY m.created_at ASC
         LIMIT 500`,
        [ticketId]
      );

      return {
        ok: true,
        data: rows.map((r) => ({
          id: r.id,
          content: r.content,
          mediaType: r.media_type || 'none',
          mediaUrl: toClientMediaUrl(r.media_url),
          mediaName: r.media_name || null,
          createdAt: r.created_at,
          isMine: r.user_id === me.id,
          author: {
            id: r.user_id,
            username: r.username,
            displayName: r.display_name || r.username,
            role: r.role,
            avatarUrl: toClientMediaUrl(r.avatar_url) || null,
          },
        })),
      };
    } catch (err) {
      console.error('tickets:messages', err);
      return { ok: false, data: [], error: 'No se pudieron cargar los mensajes' };
    }
  });

  ipcMain.handle('tickets:sendMessage', async (_e, payload = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };
      const ticketId = Number(payload.id);
      const content = String(payload.content || '').trim().slice(0, 2000);
      const mediaType = ['none', 'image', 'video', 'file'].includes(payload.mediaType)
        ? payload.mediaType
        : 'none';
      let mediaUrl = payload.mediaUrl ? String(payload.mediaUrl).slice(0, 512) : null;
      const mediaName = payload.mediaName ? String(payload.mediaName).slice(0, 255) : null;
      if (mediaUrl && mediaUrl.startsWith('annmedia://')) {
        mediaUrl = path.basename(mediaUrl.replace('annmedia://', ''));
      }
      if (!ticketId) return { ok: false, error: 'Ticket inválido' };
      if (!content && mediaType === 'none') return { ok: false, error: 'Mensaje vacío' };

      const [tickets] = await dbPool.execute('SELECT * FROM tickets WHERE id = ? LIMIT 1', [ticketId]);
      if (!tickets.length) return { ok: false, error: 'Ticket no encontrado' };
      const t = tickets[0];
      const isStaff = ['admin', 'dev'].includes(me.role);
      if (!isStaff && t.user_id !== me.id) return { ok: false, error: 'Sin permiso' };
      if (t.status === 'Cerrado') return { ok: false, error: 'El ticket está cerrado' };

      const [result] = await dbPool.execute(
        `INSERT INTO ticket_messages (ticket_id, user_id, content, media_type, media_url, media_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ticketId, me.id, content || '', mediaType, mediaUrl, mediaName]
      );
      await dbPool.execute(`UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [ticketId]);
      return { ok: true, id: result.insertId };
    } catch (err) {
      console.error('tickets:sendMessage', err);
      return { ok: false, error: 'No se pudo enviar el mensaje' };
    }
  });

  ipcMain.handle('tickets:pickMedia', async () => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };
      const result = await dialog.showOpenDialog(win, {
        title: 'Adjuntar archivo',
        properties: ['openFile'],
        filters: [
          { name: 'Archivos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'zip', 'rar', 'txt', 'log'] },
        ],
      });
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, cancelled: true };
      const src = result.filePaths[0];
      const ext = path.extname(src).toLowerCase() || '.bin';
      const key = `ticket-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      ensureMediaDir();
      fs.copyFileSync(src, path.join(mediaDir(), key));
      let mediaType = 'file';
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) mediaType = 'image';
      else if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) mediaType = 'video';
      return {
        ok: true,
        mediaType,
        mediaUrl: key,
        mediaName: path.basename(src),
        clientUrl: `annmedia://${key}`,
      };
    } catch (err) {
      console.error('tickets:pickMedia', err);
      return { ok: false, error: 'No se pudo adjuntar el archivo' };
    }
  });


  /* ───────── Profile ───────── */

  ipcMain.handle('profile:update', async (_e, payload = {}) => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };

      const displayName = String(payload.displayName ?? me.display_name ?? me.username)
        .trim()
        .slice(0, 48);
      const bio = String(payload.bio ?? me.bio ?? '')
        .trim()
        .slice(0, 500);
      const password = String(payload.currentPassword || '');

      if (!displayName) return { ok: false, error: 'El apodo no puede estar vacío' };

      const nameChanged =
        displayName !== (me.display_name || me.username);

      if (nameChanged) {
        if (!password) return { ok: false, error: 'Ingresá tu contraseña para cambiar el apodo' };
        const match = await bcrypt.compare(password, me.password);
        if (!match) return { ok: false, error: 'Contraseña incorrecta' };
      }

      try {
        await dbPool.execute(
          'UPDATE users SET display_name = ?, bio = ? WHERE id = ?',
          [displayName, bio || null, me.id]
        );
      } catch (err) {
        if (err && err.code === 'ER_BAD_FIELD_ERROR') {
          await dbPool.execute('UPDATE users SET display_name = ? WHERE id = ?', [
            displayName,
            me.id,
          ]);
        } else throw err;
      }

      const user = publicUser(await userById(me.id));
      return { ok: true, user };
    } catch (err) {
      console.error('profile:update', err);
      return { ok: false, error: 'No se pudo actualizar el perfil' };
    }
  });

  ipcMain.handle('profile:setAvatar', async () => {
    try {
      const me = await requireUser();
      if (!me) return { ok: false, error: 'Necesitás iniciar sesión' };

      const result = await dialog.showOpenDialog(win, {
        title: 'Elegir avatar',
        properties: ['openFile'],
        filters: [{ name: 'Imagen', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      });
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, cancelled: true };

      const src = result.filePaths[0];
      const ext = path.extname(src).toLowerCase() || '.png';
      const key = `avatar-${me.id}-${Date.now()}${ext}`;
      ensureMediaDir();
      fs.copyFileSync(src, path.join(mediaDir(), key));

      await dbPool.execute('UPDATE users SET avatar_url = ? WHERE id = ?', [key, me.id]);
      const user = publicUser(await userById(me.id));
      return { ok: true, user };
    } catch (err) {
      console.error('profile:setAvatar', err);
      return { ok: false, error: 'No se pudo guardar el avatar' };
    }
  });

  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win:close', () => win && win.close());
}

/* ───────── app lifecycle ───────── */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    try {
      config = loadConfig();
    } catch (err) {
      dialog.showErrorBox('Error en config.json', String(err.message || err));
      app.quit();
      return;
    }
    settings = loadSettings();
    session = loadSession();
    ensureMediaDir();

    protocol.handle('annmedia', (request) => {
      try {
        let raw = request.url.replace(/^annmedia:\/\//i, '');
        raw = decodeURIComponent(raw.split('?')[0].replace(/\/$/, ''));
        const key = path.basename(raw);
        const file = path.join(mediaDir(), key);
        if (!fs.existsSync(file)) {
          return new Response('Not found', { status: 404 });
        }
        return net.fetch(pathToFileURL(file).href);
      } catch (err) {
        console.error('annmedia protocol', err);
        return new Response('Error', { status: 500 });
      }
    });

    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
