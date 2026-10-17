(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const api = window.api;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ───── Color de acento dinámico (FL-style) ───── */

  function clamp01(n) {
    return Math.max(0, Math.min(1, n));
  }

  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function rgbToHex(r, g, b) {
    const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${to(r)}${to(g)}${to(b)}`;
  }

  /** Luminancia relativa WCAG */
  function relLuminance({ r, g, b }) {
    const lin = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastText(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#ffffff';
    // umbral tipo FL: colores claros → texto oscuro
    return relLuminance(rgb) > 0.45 ? '#0b1220' : '#ffffff';
  }

  function mixRgb(a, b, t) {
    return {
      r: a.r + (b.r - a.r) * t,
      g: a.g + (b.g - a.g) * t,
      b: a.b + (b.b - a.b) * t,
    };
  }

  function lightenHex(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const mixed = mixRgb(rgb, { r: 255, g: 255, b: 255 }, clamp01(amount));
    return rgbToHex(mixed.r, mixed.g, mixed.b);
  }

  function darkenHex(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const mixed = mixRgb(rgb, { r: 0, g: 0, b: 0 }, clamp01(amount));
    return rgbToHex(mixed.r, mixed.g, mixed.b);
  }

  function normalizeHex(input) {
    let s = String(input || '').trim();
    if (!s.startsWith('#')) s = `#${s}`;
    if (/^#[0-9A-Fa-f]{3}$/.test(s)) {
      s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(s)) return null;
    return s.toLowerCase();
  }

  function applyAccent(hex) {
    const color = normalizeHex(hex) || '#2563eb';
    const hover = lightenHex(color, 0.18);
    const deep = darkenHex(color, 0.22);
    const rgb = hexToRgb(color);
    const glow = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.28)` : 'rgba(37, 99, 235, 0.25)';
    const on = contrastText(color);
    const root = document.documentElement;
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-hover', hover);
    root.style.setProperty('--accent-deep', deep);
    root.style.setProperty('--accent-glow', glow);
    root.style.setProperty('--on-accent', on);
    // flagline / focus rings pick it up via --accent
  }

  const REACTIONS = [
    { id: 'like', label: '👍' },
    { id: 'fire', label: '🔥' },
    { id: 'heart', label: '❤️' },
    { id: 'clap', label: '👏' },
    { id: 'wow', label: '😮' },
  ];

  let CFG = null;
  let SET = null;
  let currentUser = null;
  let isRegistering = false;
  let editingAnnouncementId = null;
  let expandedComments = new Set();

  // Cache local (persistido en MySQL)
  let storePacks = [];
  let myTickets = [];
  let activeChatTicketId = null;
  let pendingTicketMedia = null;

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  let toastTimer = null;
  function toast(msg, type = 'info') {
    const el = $('#toast');
    if (el) {
      el.textContent = msg;
      el.className = 'show' + (type === 'error' ? ' error' : '');
      el.style.zIndex = '20000';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (el.className = ''), 3200);
    }
    if (type === 'error') setAuthError(msg);
  }

  function setAuthError(msg) {
    const box = $('#authGateError');
    if (!box) return;
    if (!msg) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.textContent = msg;
  }

  function setupIcons() {
    $$('img[data-icon]').forEach((img) => {
      const fail = () => img.classList.add('missing');
      img.addEventListener('error', fail);
      if (img.complete && img.naturalWidth === 0) fail();
    });
  }

  /* ───── Auth gate ───── */

  function showAuthGate(show) {
    const gate = $('#authGate');
    const app = $('.app');
    if (gate) gate.hidden = !show;
    if (app) app.classList.toggle('locked', show);
    if (show) {
      document.body.classList.add('auth-locked');
    } else {
      document.body.classList.remove('auth-locked');
    }
  }

  function updateUserUI() {
    const host = $('#titlebarUser');
    const newsBar = $('#newsActionBar');
    const logoutBtn = $('#tbLogoutBtn');
    const loginMenuBtn = $('#tbLoginMenuBtn');
    const devBtn = $('#tbDevPanelBtn');

    const isStaff =
      currentUser && (currentUser.isStaff || currentUser.role === 'admin' || currentUser.role === 'dev');
    const isDev = currentUser && (currentUser.role === 'dev' || currentUser.role === 'admin');

    if (newsBar) newsBar.hidden = !isStaff;
    if (logoutBtn) logoutBtn.hidden = !currentUser;
    if (loginMenuBtn) loginMenuBtn.hidden = !!currentUser;
    if (devBtn) devBtn.hidden = !isDev;

    if (host) {
      if (currentUser) {
        const name = currentUser.displayName || currentUser.username || 'Usuario';
        const roleLabel =
          currentUser.role === 'admin' ? 'Admin' : currentUser.role === 'dev' ? 'Dev' : 'Sobreviviente';
        const av = currentUser.avatarUrl
          ? `<div class="tb-user-avatar"><img src="${esc(currentUser.avatarUrl)}" alt=""></div>`
          : `<div class="tb-user-avatar" style="background:${avatarColor(name)}">${esc(initials(name))}</div>`;
        host.innerHTML = `
          <div class="tb-user-chip" title="${esc(name)}">
            ${av}
            <div class="tb-user-meta">
              <span class="tb-user-name">${esc(name)}</span>
              <span class="tb-user-role">${esc(roleLabel)}</span>
            </div>
          </div>`;
      } else {
        host.innerHTML = `<button type="button" class="tb-login-btn" id="tbLoginBtn">INICIAR SESIÓN</button>`;
        $('#tbLoginBtn')?.addEventListener('click', () => {
          showAuthGate(true);
          setAuthMode(false);
        });
      }
    }

    if (currentUser) initProfileData();
    /* store removed */
    loadTickets();
  }

  function setAuthMode(register) {
    isRegistering = !!register;
    const title = $('#authGateTitle');
    const submit = $('#authGateSubmit');
    const toggle = $('#authGateToggle');
    const emailRow = $('#authGateEmailRow');
    if (title) title.textContent = isRegistering ? 'Crear cuenta' : 'Iniciar sesión';
    if (submit) submit.textContent = isRegistering ? 'Registrarse' : 'Entrar';
    if (toggle)
      toggle.textContent = isRegistering
        ? '¿Ya tenés cuenta? Iniciá sesión'
        : '¿No tenés cuenta? Registrate';
    if (emailRow) emailRow.hidden = !isRegistering;
  }

  function setupAuthGate() {
    $('#authGateToggle')?.addEventListener('click', () => setAuthMode(!isRegistering));
    $('#authGateSubmit')?.addEventListener('click', submitAuth);
    ['authGateUsername', 'authGatePassword', 'authGateEmail'].forEach((id) => {
      $(`#${id}`)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitAuth();
      });
    });
  }

  function closeTbMenu() {
    const dd = $('#tbDropdown');
    const btn = $('#tbMenuBtn');
    if (dd) dd.hidden = true;
    if (btn) {
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function openTbMenu() {
    const dd = $('#tbDropdown');
    const btn = $('#tbMenuBtn');
    if (dd) dd.hidden = false;
    if (btn) {
      btn.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  }

  function navigateTo(view) {
    const btn = document.querySelector(`.nav-btn[data-view="${view}"]`);
    if (btn) btn.click();
    else {
      $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
      $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
      if (view === 'news') loadAnnouncements();
    }
  }

  function setupTitlebarMenu() {
    $('#tbMenuBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = $('#tbDropdown');
      if (!dd) return;
      if (dd.hidden) openTbMenu();
      else closeTbMenu();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.titlebar-menu-wrap')) closeTbMenu();
    });

    $('#tbDropdown')?.addEventListener('click', async (e) => {
      const item = e.target.closest('.tb-dd-item');
      if (!item) return;
      e.stopPropagation();
      closeTbMenu();

      if (item.id === 'tbLogoutBtn') {
        await api.logout();
        currentUser = null;
        updateUserUI();
        showAuthGate(true);
        setAuthMode(false);
        toast('Sesión cerrada');
        return;
      }
      if (item.id === 'tbLoginMenuBtn') {
        showAuthGate(true);
        setAuthMode(false);
        return;
      }
      if (item.id === 'tbDevPanelBtn') {
        openDevPanel();
        return;
      }
      const nav = item.dataset.nav;
      if (nav) {
        if (!currentUser && (nav === 'profile' || nav === 'tickets')) {
          showAuthGate(true);
          toast('Iniciá sesión para continuar', 'error');
          return;
        }
        navigateTo(nav);
      }
    });

    // Acceso oculto: 5 clicks en la versión (dev/admin o sin sesión para pruebas locales)
    let verClicks = 0;
    let verTimer = null;
    $('#appVer')?.addEventListener('click', () => {
      verClicks += 1;
      clearTimeout(verTimer);
      verTimer = setTimeout(() => { verClicks = 0; }, 2000);
      if (verClicks >= 5) {
        verClicks = 0;
        openDevPanel();
        toast('Panel desarrollador');
      }
    });
  }

  function openDevPanel() {
    const modal = $('#devPanelModal');
    if (!modal) return;
    const current = normalizeHex(SET?.accentColor) || '#2563eb';
    if ($('#devAccentPicker')) $('#devAccentPicker').value = current;
    if ($('#devAccentHex')) $('#devAccentHex').value = current;
    applyAccent(current);
    modal.hidden = false;
  }

  function setupDevPanel() {
    const syncInputs = (hex) => {
      const n = normalizeHex(hex);
      if (!n) return;
      if ($('#devAccentPicker')) $('#devAccentPicker').value = n;
      if ($('#devAccentHex')) $('#devAccentHex').value = n;
      applyAccent(n);
    };

    $('#closeDevPanel')?.addEventListener('click', () => {
      $('#devPanelModal').hidden = true;
      applyAccent(SET?.accentColor || '#2563eb');
    });
    $('#devPanelModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'devPanelModal') {
        $('#devPanelModal').hidden = true;
        applyAccent(SET?.accentColor || '#2563eb');
      }
    });
    $('#devAccentPicker')?.addEventListener('input', (e) => syncInputs(e.target.value));
    $('#devAccentHex')?.addEventListener('input', (e) => {
      const n = normalizeHex(e.target.value);
      if (n) {
        if ($('#devAccentPicker')) $('#devAccentPicker').value = n;
        applyAccent(n);
      }
    });
    $('#devAccentReset')?.addEventListener('click', () => syncInputs('#2563eb'));
    $('#devAccentSave')?.addEventListener('click', async () => {
      const n = normalizeHex($('#devAccentHex')?.value || $('#devAccentPicker')?.value);
      if (!n) {
        toast('Color inválido. Usá formato #RRGGBB', 'error');
        return;
      }
      applyAccent(n);
      SET = await api.saveSettings({ ...SET, accentColor: n });
      $('#devPanelModal').hidden = true;
      toast(`Color aplicado: ${n}`);
    });
  }


  async function submitAuth() {
    const username = $('#authGateUsername')?.value.trim() || '';
    const password = $('#authGatePassword')?.value || '';
    const email = $('#authGateEmail')?.value.trim() || '';
    const btn = $('#authGateSubmit');

    setAuthError('');

    if (!api || typeof api.login !== 'function') {
      setAuthError('Error interno: la API del launcher no está disponible.');
      return;
    }

    if (!username || !password || (isRegistering && !email)) {
      setAuthError('Completá todos los campos.');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Conectando…';
    }

    try {
      let res;
      if (isRegistering) {
        res = await api.register({ username, email, password });
      } else {
        res = await api.login({ username, password });
      }

      if (!res || !res.ok) {
        setAuthError((res && res.error) || 'Error de autenticación');
        return;
      }

      currentUser = res.user;
      setAuthError('');
      updateUserUI();
      showAuthGate(false);
      toast(`¡Bienvenido, ${currentUser.displayName || currentUser.username}!`);
      await loadAnnouncements();
      // badge se actualiza dentro de loadAnnouncements
      if ($('#authGatePassword')) $('#authGatePassword').value = '';
    } catch (err) {
      console.error('submitAuth', err);
      setAuthError('No se pudo conectar con la base de datos.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = isRegistering ? 'Registrarse' : 'Entrar';
      }
    }
  }

  /* ───── Branding / Rules / News ───── */

  function applyBranding() {
    const s = CFG.server;
    const m = s.name.match(/^(.*?)\s+(\d{4})$/);
    const main = m ? m[1] : s.name;
    const year = m ? m[2] : '';

    $('#titleMain').textContent = main;
    $('#titleYear').textContent = year;
    $('#tagline').textContent = s.tagline || '';
    $('#brandName').textContent = s.name;
    $('#splashTitle').textContent = s.name.toUpperCase();
    $('#mapName').textContent = s.map;
    $('#metaMap').textContent = s.map;
    $('#metaIp').textContent = `${s.ip}:${s.gamePort}`;
    $('#fIp').textContent = `${s.ip}:${s.gamePort}`;
    $('#fMap').textContent = s.map;
    $('#fJoin').textContent = s.joinUrl.replace(/^https?:\/\//, '');
    $('#tipText').textContent = CFG.communityTip || '';
    const tip = $('.tip-card');
    if (tip) tip.hidden = !CFG.communityTip;
    document.title = `${s.name} Launcher`;
  }

  function renderRules() {
    const grid = $('#rulesGrid');
    if (!grid) return;
    grid.innerHTML = (CFG.rules || [])
      .map(
        (r, i) => `
      <article class="card rule pad">
        <span class="num">${String(i + 1).padStart(2, '0')}</span>
        <div class="ico"><svg class="i"><use href="#i-${esc(r.icon || 'shield')}"/></svg></div>
        <h3>${esc(r.title)}</h3>
        <p>${esc(r.text)}</p>
      </article>`
      )
      .join('');

    const note = CFG.rulesNote;
    const noteEl = $('#rulesNote');
    if (note && noteEl) {
      noteEl.innerHTML = `
        <div class="ico"><svg class="i"><use href="#i-info"/></svg></div>
        <div><h3>${esc(note.title)}</h3><p>${esc(note.text)}</p></div>`;
    } else if (noteEl) {
      noteEl.hidden = true;
    }
  }

  function renderNews() {
    const items = (CFG.news || []).slice(0, 2);
    const card = $('#newsCard');
    if (card) card.hidden = items.length === 0;
    const list = $('#newsList');
    if (list) {
      list.innerHTML = items
        .map((n) => `<div class="news-item"><b>${esc(n.title)}</b><p>${esc(n.text)}</p></div>`)
        .join('');
    }
  }

  function setupNav() {
    $$('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
        $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
        if (btn.dataset.view === 'news') {
          loadAnnouncements().then(() => markAnnouncementsRead());
        }
      });
    });
    $('#btnMin')?.addEventListener('click', () => api.minimize());
    $('#btnMax')?.addEventListener('click', () => api.maximize());
    $('#btnClose')?.addEventListener('click', () => api.close());
    $('#gateMin')?.addEventListener('click', () => api.minimize());
    $('#gateClose')?.addEventListener('click', () => api.close());
  }

  async function setupSlideshow() {
    const names = await api.images();
    const host = $('#slides');
    const ctl = $('#slideCtl');
    if (!host) return;

    if (!names.length) {
      $('#hero')?.classList.add('empty');
      if (ctl) ctl.hidden = true;
      return;
    }

    const seconds = CFG.ui?.slideshowSeconds || 7;
    const dur = seconds * 1000;
    const slides = shuffle(names).map((name) => {
      const d = document.createElement('div');
      d.className = 'slide';
      d.dataset.src = `../assets/${encodeURIComponent(name)}`;
      host.appendChild(d);
      return d;
    });

    const prog = $('#slideProg');
    const count = $('#slideCount');
    let idx = -1;
    let timer = null;

    const load = (s) => {
      if (!s.style.backgroundImage) s.style.backgroundImage = `url("${s.dataset.src}")`;
    };

    const restartProgress = () => {
      if (!prog) return;
      prog.style.transition = 'none';
      prog.style.width = '0%';
      void prog.offsetWidth;
      prog.style.transition = `width ${dur}ms linear`;
      prog.style.width = '100%';
    };

    const show = (n) => {
      const next = ((n % slides.length) + slides.length) % slides.length;
      if (next === idx) return;
      const prev = slides[idx];
      if (prev) prev.classList.remove('active');
      const cur = slides[next];
      load(cur);
      cur.classList.add('active');
      idx = next;
      if (count)
        count.textContent = `${String(next + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
      restartProgress();
      schedule();
    };

    const schedule = () => {
      clearTimeout(timer);
      if (slides.length > 1 && !document.hidden) timer = setTimeout(() => show(idx + 1), dur);
    };

    show(0);
    if (slides.length < 2) {
      if (ctl) ctl.hidden = true;
      return;
    }
    $('#slideNext')?.addEventListener('click', () => show(idx + 1));
    $('#slidePrev')?.addEventListener('click', () => show(idx - 1));
  }

  let lastStatus = null;

  function renderStatus(s) {
    const pill = $('#statusPill');
    const side = $('#sideStatus');
    if (pill) pill.className = 'pill ' + (s.online ? 'on' : 'off');
    if ($('#statusText')) $('#statusText').textContent = s.online ? 'ONLINE' : 'OFFLINE';
    if (side) side.className = 'side-status ' + (s.online ? 'on' : 'off');

    if (s.online) {
      if ($('#plNum')) $('#plNum').textContent = s.players;
      if ($('#plMax')) $('#plMax').textContent = s.maxPlayers;
      const pct = s.maxPlayers ? Math.min(100, (s.players / s.maxPlayers) * 100) : 0;
      const bar = $('#plBar');
      if (bar) {
        bar.style.width = `${pct}%`;
        bar.classList.toggle('hot', pct >= 85);
      }
      if ($('#metaPing')) $('#metaPing').textContent = s.ping != null ? `${s.ping} ms` : '—';
      const span = side?.querySelector('span');
      if (span) span.textContent = `${s.players}/${s.maxPlayers} conectados`;
    } else {
      if ($('#plNum')) $('#plNum').textContent = '—';
      if ($('#plMax')) $('#plMax').textContent = '—';
      if ($('#plBar')) $('#plBar').style.width = '0%';
      if ($('#metaPing')) $('#metaPing').textContent = '—';
      const span = side?.querySelector('span');
      if (span) span.textContent = 'Servidor offline';
    }
    updateAge();
    renderServersList(s);
  }

  function updateAge() {
    const el = $('#statusAge');
    if (!el) return;
    if (!lastStatus) {
      el.textContent = '';
      return;
    }
    const sec = Math.max(0, Math.round((Date.now() - lastStatus.ts) / 1000));
    el.textContent = sec < 5 ? 'recién actualizado' : `hace ${sec} s`;
  }

  async function refreshStatus() {
    try {
      lastStatus = await api.status();
    } catch {
      lastStatus = { online: false, players: 0, maxPlayers: 0, ping: null, ts: Date.now() };
    }
    renderStatus(lastStatus);
  }

  function setupStatus() {
    refreshStatus();
    setInterval(refreshStatus, 30000);
    setInterval(updateAge, 1000);
  }

  function setupPlay() {
    const btn = $('#playBtn');
    if (!btn) return;
    let busy = false;

    const getMapsFromCfg = () => {
      const s = CFG?.server || {};
      if (Array.isArray(s.maps) && s.maps.length) {
        return s.maps.map((m) => ({
          id: m.id,
          name: m.name,
          gamePort: m.gamePort,
          joinUrl: m.joinUrl,
          description: m.description || '',
          ip: s.ip,
        }));
      }
      return [
        {
          id: 'default',
          name: s.map || 'Chernarus+',
          gamePort: s.gamePort,
          joinUrl: s.joinUrl,
          description: '',
          ip: s.ip,
        },
      ];
    };

    const openMapSelect = () => {
      const maps = getMapsFromCfg();
      const grid = $('#mapPickGrid');
      if (!grid) return;
      const statusMaps = lastStatus?.maps || [];
      grid.innerHTML = maps
        .map((m) => {
          const st = statusMaps.find((x) => x.id === m.id) || {};
          const online = !!st.online;
          const players = st.players != null ? `${st.players}/${st.maxPlayers || '?'}` : '—';
          return `
          <button type="button" class="map-pick-card" data-map-id="${esc(m.id)}">
            <div class="map-pick-top">
              <span class="map-pick-name">${esc(m.name)}</span>
              <span class="pill ${online ? 'on' : 'off'}"><i class="pulse"></i>${online ? 'ONLINE' : 'OFFLINE'}</span>
            </div>
            <div class="map-pick-ip">${esc(m.ip)}:${esc(String(m.gamePort))}</div>
            <div class="map-pick-desc">${esc(m.description || '')}</div>
            <div class="map-pick-players">${esc(players)} jugadores</div>
          </button>`;
        })
        .join('');
      grid.querySelectorAll('[data-map-id]').forEach((el) => {
        el.addEventListener('click', () => {
          $('#mapSelectModal').hidden = true;
          doLaunch(el.dataset.mapId);
        });
      });
      $('#mapSelectModal').hidden = false;
    };

    const doLaunch = async (mapId) => {
      if (busy) return;
      if (!currentUser) {
        showAuthGate(true);
        toast('Iniciá sesión para jugar', 'error');
        return;
      }
      busy = true;
      btn.classList.add('loading');
      const label = $('#playLabel');
      if (label) label.textContent = 'ABRIENDO…';
      const res = await api.play({ mapId });
      if (res.ok) {
        toast(res.map ? `Entrando a ${res.map}…` : 'Abriendo conexión al servidor…');
        if (SET.minimizeOnPlay) {
          /* optional */
        }
      } else toast(res.error || 'No se pudo iniciar el juego.', 'error');
      setTimeout(() => {
        btn.classList.remove('loading');
        if (label) label.textContent = 'JUGAR AHORA';
        busy = false;
      }, 3500);
    };

    btn.addEventListener('click', () => {
      const maps = getMapsFromCfg();
      if (maps.length > 1) openMapSelect();
      else doLaunch(maps[0]?.id);
    });

    $('#closeMapSelect')?.addEventListener('click', () => {
      $('#mapSelectModal').hidden = true;
    });
    $('#mapSelectModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'mapSelectModal') $('#mapSelectModal').hidden = true;
    });

    const copy = async (text, msg) => {
      await api.copy(text);
      toast(msg);
    };

    $('#copyIpBtn')?.addEventListener('click', () => {
      const maps = getMapsFromCfg();
      const text = maps.map((m) => `${m.ip}:${m.gamePort}`).join('\n');
      copy(text, 'IPs copiadas');
    });
    $('#fIpCopy')?.addEventListener('click', () => {
      const maps = getMapsFromCfg();
      copy(maps.map((m) => `${m.ip}:${m.gamePort}`).join(' · '), 'IP copiada');
    });
    $('#fJoinCopy')?.addEventListener('click', () => copy(CFG.server.joinUrl, 'Enlace copiado'));
    $('#fJoinOpen')?.addEventListener('click', () => api.openExternal(CFG.server.joinUrl));
    $('#discordBtn')?.addEventListener('click', () => api.openExternal(CFG.server.discordUrl));
    $('#commDiscord')?.addEventListener('click', () => api.openExternal(CFG.server.discordUrl));
  }

  function renderServersList(status) {
    const host = $('#serverMapsList');
    if (!host || !CFG?.server) return;
    const maps =
      status?.maps ||
      (CFG.server.maps || []).map((m) => ({
        id: m.id,
        name: m.name,
        gamePort: m.gamePort,
        ip: CFG.server.ip,
        online: false,
        players: 0,
        maxPlayers: 0,
      }));
    // ensure nasdara appears even if status still old shape
    if (!maps.length) {
      host.innerHTML = `<div class="server-row"><span>${esc(CFG.server.ip)}:${esc(String(CFG.server.gamePort))}</span></div>`;
      return;
    }
    host.innerHTML = maps
      .map((m) => {
        const online = !!m.online;
        return `
        <div class="server-row">
          <div class="server-row-main">
            <span class="server-dot ${online ? 'on' : 'off'}"></span>
            <div>
              <b>${esc(m.name || 'Mapa')}</b>
              <div class="server-ip">${esc(m.ip || CFG.server.ip)}:${esc(String(m.gamePort))}</div>
            </div>
          </div>
          <div class="server-row-meta">
            <span>${online ? `${m.players}/${m.maxPlayers}` : '—'}</span>
            <button type="button" class="btn-ghost sm" data-copy-ip="${esc(m.ip || CFG.server.ip)}:${esc(String(m.gamePort))}">Copiar</button>
          </div>
        </div>`;
      })
      .join('');
    host.querySelectorAll('[data-copy-ip]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api.copy(btn.dataset.copyIp);
        toast('IP copiada');
      });
    });
  }

  

  function setupSettings() {
    const name = $('#setName');
    const params = $('#setParams');
    const min = $('#setMin');
    const themeToggle = $('#setThemeToggle');
    if (!name) return;

    $$('input[name="mode"]').forEach((r) => (r.checked = r.value === SET.launchMode));
    name.value = SET.playerName || '';
    params.value = SET.extraParams || '';
    if (min) min.checked = !!SET.minimizeOnPlay;

    const isLight = SET.theme === 'light';
    if (themeToggle) themeToggle.checked = isLight;
    document.body.classList.toggle('light-theme', isLight);
    applyAccent(SET.accentColor || '#2563eb');

    let t = null;
    const save = (silent) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const mode = $('input[name="mode"]:checked');
        SET = await api.saveSettings({
          launchMode: mode ? mode.value : SET.launchMode,
          playerName: name.value,
          extraParams: params.value,
          minimizeOnPlay: min ? min.checked : SET.minimizeOnPlay,
          theme: themeToggle?.checked ? 'light' : 'dark',
          accentColor: SET.accentColor || '#2563eb',
          lastAnnouncementRead: SET.lastAnnouncementRead || 0,
        });
        if (!silent) toast('Ajustes guardados');
      }, 350);
    };

    $$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => save()));
    name.addEventListener('input', () => save(true));
    params.addEventListener('input', () => save(true));
    min?.addEventListener('change', () => save());
    themeToggle?.addEventListener('change', (e) => {
      document.body.classList.toggle('light-theme', e.target.checked);
      save();
    });
  }

  /* ───── Donaciones ───── */

  function setupDonate() {
    const render = () => {
      const grid = $('#donateGrid');
      if (!grid) return;
      const donate = CFG?.donate || {};
      const tiers = donate.tiers || [
        { id: 'd3', amount: 3, label: 'Apoyo básico', desc: 'Gracias por bancar el server.' },
        { id: 'd10', amount: 10, label: 'Apoyo sólido', desc: 'Ayudás a mantener mods y hosting.' },
        { id: 'd20', amount: 20, label: 'Apoyo élite', desc: 'Contribución grande para el proyecto.' },
      ];
      grid.innerHTML = tiers
        .map(
          (t) => `
        <div class="donate-card">
          <div class="donate-amount">$${Number(t.amount).toFixed(0)}</div>
          <div class="donate-label">${esc(t.label)}</div>
          <p class="donate-desc">${esc(t.desc || '')}</p>
          <button type="button" class="btn-primary" data-donate="${Number(t.amount)}">Donar $${Number(t.amount).toFixed(0)}</button>
        </div>`
        )
        .join('');
      grid.querySelectorAll('[data-donate]').forEach((btn) => {
        btn.addEventListener('click', () => openDonate(Number(btn.dataset.donate)));
      });
    };

    const openDonate = (amount) => {
      const min = Number(CFG?.donate?.minCustom) || 3;
      const value = Number(amount);
      if (!Number.isFinite(value) || value < min) {
        toast(`El monto mínimo es USD ${min.toFixed(2)}`, 'error');
        return;
      }
      const business = CFG?.donate?.paypalBusiness || 'amarootm@gmail.com';
      const currency = CFG?.donate?.currency || 'USD';
      const url = `https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=${encodeURIComponent(
        business
      )}&item_name=${encodeURIComponent('Donación Malvinas 1982')}&amount=${value.toFixed(
        2
      )}&currency_code=${encodeURIComponent(currency)}`;
      api.openExternal(url);
      toast(`Abriendo PayPal · USD ${value.toFixed(2)}`);
    };

    $('#donateCustomBtn')?.addEventListener('click', () => {
      const raw = parseFloat($('#donateCustomAmount')?.value || '0');
      openDonate(raw);
    });

    render();
  }

    /* ───── Soporte / Tickets (MySQL) ───── */

  async function loadTickets() {
    if (!currentUser) {
      myTickets = [];
      renderTickets();
      return;
    }
    try {
      const res = await api.listTickets();
      if (!res || !res.ok) {
        myTickets = [];
        if (res?.error) toast(res.error, 'error');
      } else {
        myTickets = res.data || [];
      }
    } catch (err) {
      console.error('loadTickets', err);
      myTickets = [];
    }
    renderTickets();
  }

  function renderTickets() {
    const list = $('#ticketsList');
    if (!list) return;

    if (!currentUser) {
      list.innerHTML = `<div class="card pad" style="text-align:center; color:var(--muted);">Iniciá sesión para ver y crear tickets.</div>`;
      return;
    }

    if (myTickets.length === 0) {
      list.innerHTML = `<div class="card pad" style="text-align:center; color:var(--muted);">No hay tickets para mostrar.</div>`;
      return;
    }

    list.innerHTML = myTickets
      .map((t) => {
        const who = t.claimedName
          ? ` · Reclamado por ${esc(t.claimedName)}`
          : ' · Pendiente';
        const author =
          currentUser && (currentUser.role === 'admin' || currentUser.role === 'dev') && t.authorName
            ? ` · de ${esc(t.authorName)}`
            : '';
        return `
      <div class="ticket-item" data-ticket-id="${t.id}">
        <div class="ticket-info">
          <b>#${t.id} — ${esc(t.subject)}</b>
          <span>Estado: <b class="ticket-status ${t.status === 'Cerrado' ? 'closed' : ''}">${esc(t.status)}</b>${who}${author}</span>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="btn-primary sm" data-ticket-action="chat" data-ticket-id="${t.id}">Abrir Chat</button>
          ${
            currentUser &&
            (currentUser.role === 'admin' || currentUser.role === 'dev') &&
            !t.claimedBy &&
            t.status !== 'Cerrado'
              ? `<button type="button" class="btn-ghost sm" data-ticket-action="claim" data-ticket-id="${t.id}">Reclamar</button>`
              : ''
          }
          ${
            t.status !== 'Cerrado'
              ? `<button type="button" class="btn-ghost sm" data-ticket-action="close" data-ticket-id="${t.id}">Cerrar</button>`
              : ''
          }
        </div>
      </div>`;
      })
      .join('');
  }

  async function claimTicket(id) {
    const res = await api.claimTicket(Number(id));
    if (!res.ok) {
      toast(res.error || 'No se pudo reclamar', 'error');
      return;
    }
    toast(`Reclamaste el ticket #${id}.`);
    await loadTickets();
  }

  async function closeTicket(id) {
    if (!confirm('¿Cerrar este ticket?')) return;
    const res = await api.closeTicket(Number(id));
    if (!res.ok) {
      toast(res.error || 'No se pudo cerrar', 'error');
      return;
    }
    toast(`Ticket #${id} cerrado.`);
    if (activeChatTicketId === Number(id)) {
      $('#ticketChatModal').hidden = true;
      activeChatTicketId = null;
    }
    await loadTickets();
  }

  async function openTicketChat(ticketId) {
    const id = Number(ticketId);
    const ticket = myTickets.find((t) => t.id === id);
    if (!ticket) {
      toast('Ticket no encontrado', 'error');
      return;
    }
    activeChatTicketId = id;
    pendingTicketMedia = null;
    $('#chatModalTitle').textContent = `Chat de Ticket #${id} — ${ticket.subject}`;
    $('#ticketChatModal').hidden = false;
    if ($('#chatInputMessage')) $('#chatInputMessage').value = '';
    await loadChatMessages(id);
  }

  async function loadChatMessages(ticketId) {
    const container = $('#chatMessagesContainer');
    if (!container) return;
    container.innerHTML = `<div class="muted" style="text-align:center;padding:12px;">Cargando…</div>`;

    const res = await api.getTicketMessages(Number(ticketId));
    if (!res.ok) {
      container.innerHTML = `<div class="muted" style="text-align:center;padding:12px;">${esc(res.error || 'Error')}</div>`;
      return;
    }

    const msgs = res.data || [];
    if (!msgs.length) {
      container.innerHTML = `<div class="muted" style="text-align:center;padding:12px;">Sin mensajes todavía.</div>`;
      return;
    }

    container.innerHTML = msgs
      .map((m) => {
        const name = m.author?.displayName || m.author?.username || '?';
        const mine = !!m.isMine;
        let media = '';
        if (m.mediaType === 'image' && m.mediaUrl) {
          media = `<img src="${esc(m.mediaUrl)}" alt="" style="max-width:100%;max-height:200px;border-radius:6px;margin-top:6px;">`;
        } else if (m.mediaType === 'video' && m.mediaUrl) {
          media = `<video src="${esc(m.mediaUrl)}" controls style="max-width:100%;max-height:200px;border-radius:6px;margin-top:6px;"></video>`;
        } else if (m.mediaType === 'file' && m.mediaUrl) {
          media = `<div style="font-size:11px;color:var(--accent);margin-top:4px;">📎 ${esc(m.mediaName || 'Archivo')}</div>`;
        }
        return `
      <div class="chat-bubble ${mine ? 'mine' : 'theirs'}">
        <b>${esc(name)}${m.author?.role && ['admin','dev'].includes(m.author.role) ? ' · staff' : ''}</b>
        <div>${esc(m.content || '')}</div>
        ${media}
      </div>`;
      })
      .join('');
    container.scrollTop = container.scrollHeight;
  }

  function setupTickets() {
    $('#ticketsList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ticket-action]');
      if (!btn) return;
      e.preventDefault();
      const action = btn.dataset.ticketAction;
      const id = btn.dataset.ticketId;
      if (action === 'chat') openTicketChat(id);
      else if (action === 'claim') claimTicket(id);
      else if (action === 'close') closeTicket(id);
    });

    $('#openNewTicketModal')?.addEventListener('click', () => {
      if (!currentUser) {
        showAuthGate(true);
        toast('Iniciá sesión para abrir un ticket', 'error');
        return;
      }
      $('#ticketSubject').value = '';
      $('#ticketMessage').value = '';
      $('#ticketModal').hidden = false;
    });

    $('#closeTicketModal')?.addEventListener('click', () => {
      $('#ticketModal').hidden = true;
    });
    $('#ticketModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'ticketModal') $('#ticketModal').hidden = true;
    });

    $('#submitTicketBtn')?.addEventListener('click', async () => {
      if (!currentUser) {
        toast('Iniciá sesión primero', 'error');
        return;
      }
      const subject = $('#ticketSubject').value.trim();
      const message = $('#ticketMessage').value.trim();
      if (!subject || !message) {
        toast('Completá todos los campos.', 'error');
        return;
      }
      const res = await api.createTicket({ subject, message });
      if (!res.ok) {
        toast(res.error || 'No se pudo crear', 'error');
        return;
      }
      $('#ticketModal').hidden = true;
      toast('Ticket creado exitosamente.');
      await loadTickets();
    });

    $('#closeChatModal')?.addEventListener('click', () => {
      $('#ticketChatModal').hidden = true;
      activeChatTicketId = null;
      pendingTicketMedia = null;
    });
    $('#ticketChatModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'ticketChatModal') {
        $('#ticketChatModal').hidden = true;
        activeChatTicketId = null;
        pendingTicketMedia = null;
      }
    });

    $('#attachMediaBtn')?.addEventListener('click', async () => {
      if (!api.pickTicketMedia) {
        toast('Adjuntos no disponibles', 'error');
        return;
      }
      const res = await api.pickTicketMedia();
      if (!res || res.cancelled) return;
      if (!res.ok) {
        toast(res.error || 'No se pudo adjuntar', 'error');
        return;
      }
      pendingTicketMedia = {
        mediaType: res.mediaType,
        mediaUrl: res.mediaUrl,
        mediaName: res.mediaName,
        clientUrl: res.clientUrl,
      };
      toast(`Adjunto listo: ${res.mediaName}`);
    });

    $('#sendChatMessageBtn')?.addEventListener('click', sendChatMessage);
    $('#chatInputMessage')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }

  async function sendChatMessage() {
    if (activeChatTicketId == null) return;
    const text = $('#chatInputMessage')?.value.trim() || '';
    if (!text && !pendingTicketMedia) return;

    const payload = {
      id: activeChatTicketId,
      content: text,
      mediaType: pendingTicketMedia?.mediaType || 'none',
      mediaUrl: pendingTicketMedia?.mediaUrl || null,
      mediaName: pendingTicketMedia?.mediaName || null,
    };

    const res = await api.sendTicketMessage(payload);
    if (!res.ok) {
      toast(res.error || 'No se pudo enviar', 'error');
      return;
    }
    if ($('#chatInputMessage')) $('#chatInputMessage').value = '';
    pendingTicketMedia = null;
    await loadChatMessages(activeChatTicketId);
    await loadTickets();
  }

  /* ───── Perfil (estilo Discord) ───── */

  function setupProfile() {
    $('#profileAvatarWrap')?.addEventListener('click', async () => {
      if (!currentUser) {
        showAuthGate(true);
        return;
      }
      if (!api.setAvatar) {
        // fallback file input
        $('#profileAvatarFile')?.click();
        return;
      }
      const res = await api.setAvatar();
      if (!res || res.cancelled) return;
      if (!res.ok) {
        toast(res.error || 'No se pudo guardar el avatar', 'error');
        return;
      }
      currentUser = res.user;
      updateUserUI();
      initProfileData();
      toast('Avatar actualizado');
    });

    $('#profileAvatarFile')?.addEventListener('change', async (e) => {
      // legacy local preview only if API missing
      const file = e.target.files?.[0];
      if (!file) return;
      toast('Usá el lápiz del avatar (selector nativo) para guardar en el servidor.', 'error');
    });

    $('#profileBio')?.addEventListener('input', () => {
      const n = ($('#profileBio').value || '').length;
      if ($('#profileBioCount')) $('#profileBioCount').textContent = String(n);
    });

    $('#profileDisplayName')?.addEventListener('input', () => {
      const v = $('#profileDisplayName').value.trim() || currentUser?.username || 'Usuario';
      if ($('#profileDisplayLabel')) $('#profileDisplayLabel').textContent = v;
    });

    $('#saveProfileBtn')?.addEventListener('click', async () => {
      if (!currentUser) {
        showAuthGate(true);
        return;
      }
      const displayName = $('#profileDisplayName')?.value.trim() || '';
      const bio = $('#profileBio')?.value || '';
      const password = $('#profileCurrentPassword')?.value || '';

      if (!displayName) {
        toast('El apodo no puede estar vacío.', 'error');
        return;
      }

      const res = await api.updateProfile({
        displayName,
        bio,
        currentPassword: password,
      });
      if (!res.ok) {
        toast(res.error || 'No se pudo guardar', 'error');
        return;
      }
      currentUser = res.user;
      if ($('#profileCurrentPassword')) $('#profileCurrentPassword').value = '';
      updateUserUI();
      initProfileData();
      toast('Perfil guardado');
    });
  }

  function initProfileData() {
    if (!currentUser) return;
    const name = currentUser.displayName || currentUser.username || 'Usuario';
    const role =
      currentUser.role === 'admin' ? 'Admin' : currentUser.role === 'dev' ? 'Dev' : 'Miembro';

    if ($('#profileUsername')) $('#profileUsername').value = currentUser.username || '';
    if ($('#profileUsernameLabel')) $('#profileUsernameLabel').textContent = `@${currentUser.username || ''}`;
    if ($('#profileDisplayName')) $('#profileDisplayName').value = name;
    if ($('#profileDisplayLabel')) $('#profileDisplayLabel').textContent = name;
    if ($('#profileRolePill')) $('#profileRolePill').textContent = role;
    if ($('#profileBio')) {
      $('#profileBio').value = currentUser.bio || '';
      if ($('#profileBioCount')) $('#profileBioCount').textContent = String((currentUser.bio || '').length);
    }

    const preview = $('#profileAvatarPreview');
    if (preview) {
      if (currentUser.avatarUrl) {
        preview.innerHTML = `<img src="${esc(currentUser.avatarUrl)}" alt="">`;
      } else {
        preview.innerHTML = `<span id="profileAvatarInitial">${esc(initials(name))}</span>`;
        preview.style.background = avatarColor(name);
      }
    }

    // banner follows accent
    const banner = $('#profileBanner');
    if (banner) {
      banner.style.background = `linear-gradient(135deg, color-mix(in srgb, var(--accent) 60%, #111) 0%, #0b0f17 100%)`;
    }
  }

  /* ───── Anuncios no leídos ───── */

  function getLastReadTs() {
    return Number(SET?.lastAnnouncementRead || 0) || 0;
  }

  async function markAnnouncementsRead() {
    const ts = Date.now();
    try {
      SET = await api.saveSettings({ ...SET, lastAnnouncementRead: ts });
    } catch {
      if (SET) SET.lastAnnouncementRead = ts;
    }
    updateNewsBadge(0);
  }

  function updateNewsBadge(count) {
    const badge = $('#newsBadge');
    if (!badge) return;
    const n = Number(count) || 0;
    if (n <= 0) {
      badge.hidden = true;
      badge.textContent = '0';
    } else {
      badge.hidden = false;
      badge.textContent = n > 99 ? '99+' : String(n);
    }
  }

  function countUnread(list) {
    const last = getLastReadTs();
    if (!last) return (list || []).length;
    return (list || []).filter((a) => {
      const t = new Date(a.createdAt).getTime();
      return Number.isFinite(t) && t > last;
    }).length;
  }

    /* ───── Announcements (social feed) ───── */

  const EMOJI_PICKER = ['👍','❤️','🔥','😂','😮','😢','👏','🎉','⚔️','🛡️','💀','🇦🇷','❄️','🎯','💪','🙌','👀','✅'];

  function formatDate(d) {
    try {
      const dt = new Date(d);
      const now = Date.now();
      const diff = Math.max(0, (now - dt.getTime()) / 1000);
      if (diff < 60) return 'ahora';
      if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
      if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
      if (diff < 604800) return `hace ${Math.floor(diff / 86400)} d`;
      return dt.toLocaleString('es-AR', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function initials(name) {
    const p = String(name || '?').trim().split(/\s+/);
    return ((p[0]?.[0] || '?') + (p[1]?.[0] || '')).toUpperCase();
  }

  function avatarColor(name) {
    let h = 0;
    const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return `hsl(${hue} 55% 42%)`;
  }

  let openEmojiFor = null;

  function mediaHtml(ann) {
    if (!ann.mediaUrl || ann.mediaType === 'none') return '';
    if (ann.mediaType === 'image') {
      return `<div class="ann-media image"><img src="${esc(ann.mediaUrl)}" alt="" loading="lazy"></div>`;
    }
    if (ann.mediaType === 'video') {
      return `<div class="ann-media video"><video src="${esc(ann.mediaUrl)}" controls preload="metadata" playsinline></video></div>`;
    }
    return `<div class="ann-media link"><a href="#" data-open="${esc(ann.mediaUrl)}">🔗 ${esc(ann.mediaName || ann.mediaUrl)}</a></div>`;
  }

  function reactionsHtml(ann) {
    const entries = Object.entries(ann.reactions || {}).filter(([, n]) => n > 0);
    const mine = new Set(ann.myReactions || []);
    const chips = entries
      .map(([emoji, count]) => {
        const active = mine.has(emoji) ? ' active' : '';
        return `<button type="button" class="react-chip${active}" data-react="${esc(emoji)}" data-id="${ann.id}">
          <span class="react-emoji">${emoji}</span><b>${count}</b>
        </button>`;
      })
      .join('');
    return `<div class="ann-reactions" data-ann-reacts="${ann.id}">
      ${chips}
      <button type="button" class="react-add" data-open-emoji="${ann.id}" title="Reaccionar">＋</button>
    </div>`;
  }

  function closeEmojiPickers() {
    $$('.emoji-popover').forEach((el) => el.remove());
    openEmojiFor = null;
  }

  function showEmojiPicker(anchorBtn, annId) {
    closeEmojiPickers();
    openEmojiFor = annId;
    const pop = document.createElement('div');
    pop.className = 'emoji-popover';
    pop.innerHTML = EMOJI_PICKER.map(
      (e) => `<button type="button" class="emoji-opt" data-pick="${e}" data-id="${annId}">${e}</button>`
    ).join('');
    anchorBtn.parentElement.appendChild(pop);
    pop.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const res = await api.reactAnnouncement(Number(btn.dataset.id), btn.dataset.pick);
        closeEmojiPickers();
        if (!res.ok) toast(res.error || 'Error', 'error');
        else await loadAnnouncements();
      });
    });
  }

  function renderAnnouncementCard(ann, isUnread = false) {
    const authorName = ann.author?.displayName || ann.author?.username || '—';
    const role = ann.author?.role || 'user';
    const staffBadge = ['admin', 'dev'].includes(role)
      ? `<span class="ann-staff">${esc(role)}</span>`
      : '';
    const sections = (ann.sections || [])
      .map((s) => `<span class="ann-section">${esc(s)}</span>`)
      .join('');
    const avatar = ann.author?.avatarUrl
      ? `<img class="ann-avatar-img" src="${esc(ann.author.avatarUrl)}" alt="">`
      : `<span class="ann-avatar-initials">${esc(initials(authorName))}</span>`;
    const avatarStyle = ann.author?.avatarUrl ? '' : ` style="background:${avatarColor(authorName)}"`;
    const body = esc(ann.content).replace(/\n/g, '<br>');
    const adminBtns = ann.canEdit
      ? `<div class="ann-head-actions">
          <button type="button" class="ann-icon-btn" data-edit="${ann.id}" title="Editar">✎</button>
          <button type="button" class="ann-icon-btn danger" data-del="${ann.id}" title="Eliminar">🗑</button>
        </div>`
      : '';

    return `
      <article class="ann-card${ann.pinned ? ' is-pinned' : ''}${isUnread ? ' is-unread' : ''}" data-ann="${ann.id}">
        <header class="ann-head">
          <div class="ann-avatar"${avatarStyle}>${avatar}</div>
          <div class="ann-head-main">
            <div class="ann-name-line">
              <span class="ann-name">${esc(authorName)}</span>
              ${staffBadge}
              ${ann.pinned ? '<span class="ann-pin" title="Fijado">📌</span>' : ''}
            </div>
            <div class="ann-meta-line">
              <span class="ann-cat">${esc(ann.category || 'Novedad')}</span>
              ${sections}
              <span class="ann-time">${esc(formatDate(ann.createdAt))}</span>
            </div>
          </div>
          ${adminBtns}
        </header>
        <div class="ann-content">
          <h3 class="ann-title">${esc(ann.title)}</h3>
          <div class="ann-text">${body}</div>
          ${mediaHtml(ann)}
        </div>
        <footer class="ann-foot">
          ${reactionsHtml(ann)}
          <div class="ann-toolbar">
            <button type="button" class="ann-tool" data-toggle-comments="${ann.id}">
              <span class="chev">▾</span>
              <span>💬</span>
              <span class="ann-tool-count">${ann.commentCount || 0}</span>
              <span>comentarios</span>
            </button>
          </div>
        </footer>
        <div class="ann-comments" id="comments-${ann.id}" hidden>
          <div class="ann-comments-inner"></div>
        </div>
      </article>`;
  }

  async function loadAnnouncements() {
    const grid = $('#announcementsGrid');
    if (!grid) return;
    if (!currentUser) {
      grid.innerHTML = `<div class="feed-empty">Iniciá sesión para ver el feed.</div>`;
      return;
    }

    grid.innerHTML = `<div class="feed-empty">Cargando feed…</div>`;
    const res = await api.getAnnouncements();
    if (!res.ok) {
      grid.innerHTML = `<div class="feed-empty">${esc(res.error || 'Error al cargar')}</div>`;
      return;
    }
    if (!res.data.length) {
      grid.innerHTML = `<div class="feed-empty">
        <div class="feed-empty-ico">📡</div>
        <b>Todavía no hay publicaciones</b>
        <p>Cuando el staff publique, van a aparecer acá.</p>
      </div>`;
      return;
    }
    const unread = countUnread(res.data);
    const onNews = $('#view-news')?.classList.contains('active');
    if (onNews) {
      await markAnnouncementsRead();
    } else {
      updateNewsBadge(unread);
    }

    const keepOpen = new Set(expandedComments);
    grid.innerHTML = res.data
      .map((ann) => {
        const t = new Date(ann.createdAt).getTime();
        const isUnread = getLastReadTs() && t > getLastReadTs();
        // when just marked read, no unread class
        const markUnread = !onNews && isUnread;
        return renderAnnouncementCard(ann, markUnread);
      })
      .join('');
    bindAnnouncementEvents(grid);
    for (const id of keepOpen) {
      const box = $(`#comments-${id}`);
      if (box) {
        expandedComments.delete(id);
        await toggleComments(id);
      }
    }
  }

  function bindAnnouncementEvents(root) {
    root.querySelectorAll('[data-react]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await api.reactAnnouncement(Number(btn.dataset.id), btn.dataset.react);
        if (!res.ok) toast(res.error || 'Error', 'error');
        else await loadAnnouncements();
      });
    });

    root.querySelectorAll('[data-open-emoji]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.openEmoji);
        if (openEmojiFor === id) closeEmojiPickers();
        else showEmojiPicker(btn, id);
      });
    });

    root.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => openPostModal(Number(btn.dataset.edit)));
    });

    root.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar esta publicación?')) return;
        const res = await api.deleteAnnouncement(Number(btn.dataset.del));
        if (!res.ok) toast(res.error || 'Error', 'error');
        else {
          toast('Publicación eliminada');
          await loadAnnouncements();
        }
      });
    });

    root.querySelectorAll('[data-open]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        api.openExternal(a.dataset.open);
      });
    });

    root.querySelectorAll('[data-toggle-comments]').forEach((btn) => {
      btn.addEventListener('click', () => toggleComments(Number(btn.dataset.toggleComments)));
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.emoji-popover') && !e.target.closest('[data-open-emoji]')) {
      closeEmojiPickers();
    }
  });

  function buildCommentTree(list) {
    const byParent = new Map();
    for (const c of list) {
      const pid = c.parentId || null;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(c);
    }
    function walk(parentId, depth) {
      return (byParent.get(parentId) || []).map((c) => ({ ...c, depth, children: walk(c.id, depth + 1) }));
    }
    return walk(null, 0);
  }

  function avatarHtml(name, url, sizeClass) {
    const cls = sizeClass || '';
    if (url) {
      return `<div class="avatar ${cls} has-img"><img src="${esc(url)}" alt=""></div>`;
    }
    return `<div class="avatar ${cls}" style="background:${avatarColor(name)}">${esc(initials(name))}</div>`;
  }

  function renderCommentNode(c, annId) {
    const name = c.author?.displayName || c.author?.username || '?';
    const avatarUrl = c.author?.avatarUrl || null;
    const kids = (c.children || []).map((ch) => renderCommentNode(ch, annId)).join('');
    const depth = Math.min(c.depth || 0, 4);
    return `
      <div class="comment" data-cmt="${c.id}" style="--depth:${depth}">
        ${avatarHtml(name, avatarUrl, 'sm')}
        <div class="comment-body">
          <div class="comment-head">
            <b>${esc(name)}</b>
            <span class="muted">${esc(formatDate(c.createdAt))}</span>
          </div>
          <p class="comment-text">${esc(c.content)}</p>
          ${kids ? `<div class="comment-children">${kids}</div>` : ''}
        </div>
      </div>`;
  }

  async function toggleComments(annId) {
    const box = $(`#comments-${annId}`);
    const toggleBtn = document.querySelector(`[data-toggle-comments="${annId}"]`);
    if (!box) return;

    if (box.classList.contains('open') && expandedComments.has(annId)) {
      box.classList.add('closing');
      if (toggleBtn) toggleBtn.classList.remove('expanded');
      expandedComments.delete(annId);
      setTimeout(() => {
        box.classList.remove('open', 'closing');
        box.hidden = true;
        box.innerHTML = '<div class="ann-comments-inner"></div>';
      }, 200);
      return;
    }

    expandedComments.add(annId);
    box.hidden = false;
    box.classList.remove('closing');
    box.classList.add('open');
    if (toggleBtn) toggleBtn.classList.add('expanded');
    box.innerHTML = `<div class="ann-comments-inner"><p class="muted pad-sm">Cargando comentarios…</p></div>`;

    const res = await api.getComments(annId);
    if (!res.ok) {
      box.innerHTML = `<div class="ann-comments-inner"><p class="muted pad-sm">${esc(res.error || 'Error')}</p></div>`;
      return;
    }
    if (!expandedComments.has(annId)) return;

    const tree = buildCommentTree(res.data || []);
    const list = tree.length
      ? tree.map((c) => renderCommentNode(c, annId)).join('')
      : `<p class="muted pad-sm">Sé el primero en comentar.</p>`;

    box.innerHTML = `<div class="ann-comments-inner">
      <div class="comment-list">${list}</div>
      <div class="comment-composer">
        <input class="input" id="cmt-input-${annId}" maxlength="1000" placeholder="Escribí un comentario…">
        <button type="button" class="btn-primary sm" data-send-cmt="${annId}">Publicar</button>
      </div>
    </div>`;

    const send = async () => {
      const input = $(`#cmt-input-${annId}`);
      const text = input?.value.trim();
      if (!text) return;
      const r = await api.postComment(annId, text, null);
      if (!r.ok) toast(r.error || 'Error', 'error');
      else {
        expandedComments.delete(annId);
        box.classList.remove('open');
        await toggleComments(annId);
        await loadAnnouncements();
      }
    };
    box.querySelector(`[data-send-cmt="${annId}"]`)?.addEventListener('click', send);
    $(`#cmt-input-${annId}`)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    });
  }

  function setMediaPreview(type, url, name) {
    const prev = $('#postMediaPreview');
    const img = $('#postMediaPreviewImg');
    const vid = $('#postMediaPreviewVid');
    const label = $('#postMediaLabel');
    if ($('#postMediaType')) $('#postMediaType').value = type || 'none';
    if ($('#postMediaUrl')) $('#postMediaUrl').value = url || '';
    if ($('#postMediaName')) $('#postMediaName').value = name || '';
    if (!prev) return;
    if (!type || type === 'none' || !url) {
      prev.hidden = true;
      if (img) { img.hidden = true; img.removeAttribute('src'); }
      if (vid) { vid.hidden = true; vid.removeAttribute('src'); }
      return;
    }
    prev.hidden = false;
    if (label) label.textContent = name || url;
    if (type === 'image' && img) {
      img.hidden = false;
      img.src = url.startsWith('http') || url.startsWith('annmedia:') ? url : `annmedia://${url}`;
    } else if (type === 'video' && vid) {
      vid.hidden = false;
      vid.src = url.startsWith('http') || url.startsWith('annmedia:') ? url : `annmedia://${url}`;
    }
  }

  async function openPostModal(editId = null) {
    editingAnnouncementId = editId;
    const modal = $('#postModal');
    if (!modal) return;

    if ($('#postTitle')) $('#postTitle').value = '';
    if ($('#postContent')) $('#postContent').value = '';
    if ($('#postCategory')) $('#postCategory').value = 'Novedad';
    if ($('#postSections')) $('#postSections').value = '';
    if ($('#postPinned')) $('#postPinned').checked = false;
    setMediaPreview('none', '', '');
    if ($('#postModalTitle')) $('#postModalTitle').textContent = editId ? 'Editar publicación' : 'Nueva publicación';
    if ($('#postSubmit')) $('#postSubmit').textContent = editId ? 'Guardar cambios' : 'Publicar';

    if (editId) {
      const res = await api.getAnnouncements();
      const ann = (res.data || []).find((a) => a.id === editId);
      if (ann) {
        $('#postTitle').value = ann.title;
        $('#postContent').value = ann.content;
        $('#postCategory').value = ann.category || 'Novedad';
        $('#postSections').value = (ann.sections || []).join(', ');
        $('#postPinned').checked = !!ann.pinned;
        const rawUrl = ann.mediaUrl || '';
        const key = rawUrl.replace(/^annmedia:\/\//, '');
        setMediaPreview(ann.mediaType || 'none', key, ann.mediaName || '');
      }
    }

    modal.hidden = false;
  }

  function setupPostModal() {
    $('#openPostModalBtn')?.addEventListener('click', () => openPostModal(null));
    $('#closePostModal')?.addEventListener('click', () => {
      $('#postModal').hidden = true;
      editingAnnouncementId = null;
    });
    $('#pickImageBtn')?.addEventListener('click', async () => {
      const res = await api.pickMedia('image');
      if (!res || res.cancelled) return;
      if (!res.ok) return toast(res.error || 'No se pudo subir', 'error');
      setMediaPreview(res.mediaType, res.mediaUrl, res.mediaName);
      toast('Imagen lista para publicar');
    });
    $('#pickVideoBtn')?.addEventListener('click', async () => {
      const res = await api.pickMedia('video');
      if (!res || res.cancelled) return;
      if (!res.ok) return toast(res.error || 'No se pudo subir', 'error');
      setMediaPreview(res.mediaType, res.mediaUrl, res.mediaName);
      toast('Video listo para publicar');
    });
    $('#clearMediaBtn')?.addEventListener('click', () => setMediaPreview('none', '', ''));

    $('#postSubmit')?.addEventListener('click', async () => {
      const payload = {
        title: $('#postTitle').value.trim(),
        content: $('#postContent').value.trim(),
        category: $('#postCategory').value.trim() || 'Novedad',
        sections: $('#postSections').value,
        mediaType: $('#postMediaType').value,
        mediaUrl: $('#postMediaUrl').value.trim(),
        mediaName: $('#postMediaName').value.trim(),
        pinned: $('#postPinned').checked,
      };

      let res;
      if (editingAnnouncementId) {
        res = await api.updateAnnouncement({ id: editingAnnouncementId, ...payload });
      } else {
        res = await api.createAnnouncement(payload);
      }

      if (!res.ok) {
        toast(res.error || 'Error al guardar', 'error');
        return;
      }
      toast(editingAnnouncementId ? 'Publicación actualizada' : '¡Publicado!');
      $('#postModal').hidden = true;
      editingAnnouncementId = null;
      await loadAnnouncements();
    });
  }

  /* ───── Init ───── */

  async function init() {
    setupIcons();
    setupNav();
    setupAuthGate();
    setupTitlebarMenu();
    setupDevPanel();
    setupProfile();
    setupPostModal();

    if (!api) {
      toast('Error interno: no se pudo conectar con la aplicación.', 'error');
      return;
    }

    const boot = await api.boot();
    CFG = boot.config;
    SET = boot.settings;
    currentUser = boot.user || null;
    applyAccent(SET?.accentColor || '#2563eb');
    if ($('#appVer')) $('#appVer').textContent = `v${boot.version}`;

    applyBranding();
    renderRules();
    renderNews();
    setupPlay();
    setupSettings();
    setupDonate();
    setupTickets();
    /* store removed */
    await loadTickets();
    updateUserUI();

    if (!currentUser) {
      showAuthGate(true);
      setAuthMode(false);
    } else {
      showAuthGate(false);
      await loadAnnouncements();
    }

    await setupSlideshow();
    setupStatus();

    setTimeout(() => {
      const sp = $('#splash');
      if (!sp) return;
      sp.classList.add('hide');
      setTimeout(() => sp.remove(), 600);
    }, 900);
  }

  init().catch((err) => {
    console.error(err);
    $('#splash')?.classList.add('hide');
    toast('Ocurrió un error al iniciar el launcher.', 'error');
  });
})();