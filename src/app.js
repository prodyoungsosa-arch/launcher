(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const api = window.api;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  // Estado global para Tienda y Tickets
  let storePacks = [
    { id: 1, name: 'Pack Soldado Raso', description: 'Arma secundaria, 3 cargadores y kit médico básico.', price: 5.00, icon: 'shield' },
    { id: 2, name: 'Pack Comando Táctico', description: 'Fusil de asalto, chaleco nivel 3 y brújula militar.', price: 12.50, icon: 'lock' },
    { id: 3, name: 'Membresía VIP Mensual', description: 'Acceso prioritario al servidor, kit VIP diario y color de chat exclusivo.', price: 20.00, icon: 'star' }
  ];
  let myTickets = [];
  let activeChatTicketId = null;

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
    const display = $('#userInfoDisplay');
    const authBtn = $('#authModalBtn');
    const newsBar = $('#newsActionBar');
    if (!display) return;

    if (currentUser) {
      const roleLabel =
        currentUser.role === 'admin' ? 'Admin' : currentUser.role === 'dev' ? 'Dev' : 'Sobreviviente';
      display.innerHTML = `
        <span class="user-logged">${esc(currentUser.displayName || currentUser.username)}</span>
        <span class="user-role">${esc(roleLabel)}</span>`;
      if (authBtn) authBtn.textContent = 'Salir';
      if (newsBar) newsBar.hidden = !currentUser.isStaff && currentUser.role !== 'admin' && currentUser.role !== 'dev';
      
      // Actualizar datos en la vista de perfil
      initProfileData();
    } else {
      display.innerHTML = `<span class="user-guest">No conectado</span>`;
      if (authBtn) authBtn.textContent = 'Iniciar Sesión';
      if (newsBar) newsBar.hidden = true;
    }
    renderStore();
    renderTickets();
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

    $('#authModalBtn')?.addEventListener('click', async () => {
      if (currentUser) {
        await api.logout();
        currentUser = null;
        updateUserUI();
        showAuthGate(true);
        setAuthMode(false);
        toast('Sesión cerrada');
      } else {
        showAuthGate(true);
      }
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
        $$('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));$$
('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
        if (btn.dataset.view === 'news') loadAnnouncements();
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
    const label = $('#playLabel');
    if (!btn) return;
    let busy = false;

    btn.addEventListener('click', async () => {
      if (busy) return;
      if (!currentUser) {
        showAuthGate(true);
        toast('Iniciá sesión para jugar', 'error');
        return;
      }
      busy = true;
      btn.classList.add('loading');
      if (label) label.textContent = 'INICIANDO…';
      let res;
      try {
        res = await api.play();
      } catch {
        res = { ok: false, error: 'No se pudo iniciar el juego.' };
      }
      if (res.ok) toast(res.mode === 'steam' ? 'Iniciando DayZ desde Steam…' : 'Abriendo conexión al servidor…');
      else toast(res.error || 'No se pudo iniciar el juego.', 'error');
      setTimeout(() => {
        btn.classList.remove('loading');
        if (label) label.textContent = 'JUGAR';
        busy = false;
      }, 3500);
    });

    const ipFull = () => `${CFG.server.ip}:${CFG.server.gamePort}`;
    const copy = async (text, msg) => {
      await api.copy(text);
      toast(msg);
    };

    $('#copyIpBtn')?.addEventListener('click', () => copy(ipFull(), 'IP copiada al portapapeles'));
    $('#fIpCopy')?.addEventListener('click', () => copy(ipFull(), 'IP copiada al portapapeles'));
    $('#fJoinCopy')?.addEventListener('click', () => copy(CFG.server.joinUrl, 'Enlace copiado'));
    $('#fJoinOpen')?.addEventListener('click', () => api.openExternal(CFG.server.joinUrl));
    $('#discordBtn')?.addEventListener('click', () => api.openExternal(CFG.server.discordUrl));
    $('#commDiscord')?.addEventListener('click', () => api.openExternal(CFG.server.discordUrl));
  }

  function setupSettings() {
    const name = $('#setName');
    const params = $('#setParams');
    const min = $('#setMin');
    const themeToggle = $('#setThemeToggle'); if (!name) return;      $$('input[name="mode"]').forEach((r) => (r.checked = r.value === SET.launchMode));
    name.value = SET.playerName || '';
    params.value = SET.extraParams || '';
    if (min) min.checked = !!SET.minimizeOnPlay;

    const isLight = SET.theme === 'light';
    if (themeToggle) themeToggle.checked = isLight;
    document.body.classList.toggle('light-theme', isLight);

    let t = null;
    const save = (silent) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const mode = $('input[name="mode"]:checked'); SET = await api.saveSettings({ launchMode: mode ? mode.value : SET.launchMode, playerName: name.value, extraParams: params.value, minimizeOnPlay: min ? min.checked : SET.minimizeOnPlay, theme: themeToggle?.checked ? 'light' : 'dark', }); if (!silent) toast('Ajustes guardados'); }, 350); };      $$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => save()));
    name.addEventListener('input', () => save(true));
    params.addEventListener('input', () => save(true));
    min?.addEventListener('change', () => save());
    themeToggle?.addEventListener('change', (e) => {
      document.body.classList.toggle('light-theme', e.target.checked);
      save();
    });
  }

  /* ───── Tienda VIP y Packs ───── */

  function renderStore() {
    const grid = $('#storeGrid');
    if (!grid) return;
    
    const addBtn = $('#openAddPackModal');
    if (addBtn && currentUser && (currentUser.role === 'admin' || currentUser.role === 'dev')) {
      addBtn.style.display = 'inline-flex';
    } else if (addBtn) {
      addBtn.style.display = 'none';
    }

    grid.innerHTML = storePacks.map(pack => `
      <div class="store-card">
        ${currentUser && (currentUser.role === 'admin' || currentUser.role === 'dev') ? `
          <div class="store-actions-admin">
            <button type="button" class="icon-btn" onclick="window.editPack(${pack.id})" title="Editar"><svg class="i"><use href="#i-sliders"/></svg></button>
            <button type="button" class="icon-btn" onclick="window.deletePack(${pack.id})" title="Eliminar" style="color:var(--bad)"><svg class="i"><use href="#i-x"/></svg></button>
          </div>
        ` : ''}
        <div class="store-card-icon"><svg class="i"><use href="#i-${esc(pack.icon || 'shield')}"/></svg></div>
        <h3>${esc(pack.name)}</h3>
        <p>${esc(pack.description || pack.desc)}</p>
        <div class="store-card-footer">
          <span class="store-price">$${parseFloat(pack.price).toFixed(2)} USD</span>
          <button type="button" class="btn-primary" onclick="window.buyPack(${pack.id})">Comprar con PayPal</button>
        </div>
      </div>
    `).join('');
  }

  window.buyPack = function(id) {
    const pack = storePacks.find(p => p.id === id);
    if (!pack) return;
    const paypalUrl = `https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=amarootm@gmail.com&item_name=${encodeURIComponent(pack.name)}&amount=${pack.price}&currency_code=USD`;
    api.openExternal(paypalUrl);
    toast(`Redirigiendo a PayPal para abonar $${pack.price} USD...`);
  };

  window.deletePack = function(id) {
    storePacks = storePacks.filter(p => p.id !== id);
    renderStore();
    toast('Pack eliminado correctamente.');
  };

  window.editPack = function(id) {
    const pack = storePacks.find(p => p.id === id);
    if (!pack) return;
    $('#packEditId').value = pack.id;
    $('#packNameInput').value = pack.name;
    $('#packDescInput').value = pack.description || pack.desc;
    $('#packPriceInput').value = pack.price;
    $('#packIconSelect').value = pack.icon || 'shield';
    $('#packModal').hidden = false;
  };

  $('#openAddPackModal')?.addEventListener('click', () => {
    $('#packEditId').value = '';
    $('#packNameInput').value = '';
    $('#packDescInput').value = '';
    $('#packPriceInput').value = '';
    $('#packModal').hidden = false;
  });

  $('#closePackModal')?.addEventListener('click', () => {
    $('#packModal').hidden = true;
  });

  $('#savePackBtn')?.addEventListener('click', () => {
    const editId = $('#packEditId').value;
    const name = $('#packNameInput').value.trim();
    const description = $('#packDescInput').value.trim();
    const price = parseFloat($('#packPriceInput').value);
    const icon = $('#packIconSelect').value;

    if (!name || isNaN(price)) {
      toast('Completá los campos correctamente.', true);
      return;
    }

    if (editId) {
      const pack = storePacks.find(p => p.id == editId);
      if (pack) { pack.name = name; pack.description = description; pack.desc = description; pack.price = price; pack.icon = icon; }
    } else {
      storePacks.push({ id: Date.now(), name, description, desc: description, price, icon });
    }

    $('#packModal').hidden = true;
    renderStore();
    toast('Pack guardado con éxito.');
  });

  /* ───── Soporte / Tickets ───── */

  function renderTickets() {
    const list = $('#ticketsList');
    if (!list) return;

    if (myTickets.length === 0) {
      list.innerHTML = `<div class="card pad" style="text-align:center; color:var(--muted);">No tenés ningún ticket abierto.</div>`;
      return;
    }

    list.innerHTML = myTickets.map(t => `
      <div class="ticket-item">
        <div class="ticket-info">
          <b>#${t.id} - ${esc(t.subject)}</b>
          <span>Estado: <b class="ticket-status ${t.status === 'Cerrado' ? 'closed' : ''}">${esc(t.status)}</b> ${t.claimed_by ? '• Reclamado por Staff' : '• Pendiente'}</span>
        </div>
        <div style="display:flex; gap:6px;">
          <button type="button" class="btn-primary sm" onclick="window.openTicketChat(${t.id})">Abrir Chat</button>
          ${currentUser && (currentUser.role === 'admin' || currentUser.role === 'dev') && !t.claimed_by ? `
            <button type="button" class="btn-ghost sm" onclick="window.claimTicket(${t.id})">Reclamar</button>
          ` : ''}
        </div>
      </div>
    `).join('');
  }

  $('#openNewTicketModal')?.addEventListener('click', () => {
    const openCount = myTickets.filter(t => t.status !== 'Cerrado').length;
    if (openCount >= 3) {
      toast('Límite alcanzado: No puedes tener más de 3 tickets abiertos simultáneamente.', true);
      return;
    }
    $('#ticketModal').hidden = false;
  });

  $('#closeTicketModal')?.addEventListener('click', () => {
    $('#ticketModal').hidden = true;
  });

  $('#submitTicketBtn')?.addEventListener('click', () => {
    const subject = $('#ticketSubject').value.trim();
    const message = $('#ticketMessage').value.trim();
    if (!subject || !message) {
      toast('Completá todos los campos.', true);
      return;
    }

    myTickets.unshift({ id: Date.now(), subject, message, status: 'Abierto', claimed_by: null, messages: [{ sender: currentUser?.displayName || 'Usuario', text: message, media: null }] });
    $('#ticketModal').hidden = true;
    $('#ticketSubject').value = '';
    $('#ticketMessage').value = '';
    renderTickets();
    toast('Ticket creado exitosamente.');
  });

  window.claimTicket = function(id) {
    const ticket = myTickets.find(t => t.id === id);
    if (ticket) {
      ticket.claimed_by = currentUser.id;
      ticket.status = 'En Proceso';
      renderTickets();
      toast(`Has reclamado el ticket #${id}.`);
    }
  };

  window.openTicketChat = function(ticketId) {
    activeChatTicketId = ticketId;
    $('#chatModalTitle').textContent = `Chat de Ticket #${ticketId}`;
    $('#ticketChatModal').hidden = false;
    loadChatMessages(ticketId);
  };

  $('#closeChatModal')?.addEventListener('click', () => {
    $('#ticketChatModal').hidden = true;
  });

  function loadChatMessages(ticketId) {
    const ticket = myTickets.find(t => t.id === ticketId);
    const container = $('#chatMessagesContainer');
    if (!container) return;

    const msgs = ticket?.messages || [{ sender: 'Soporte', text: 'Hola, ¿en qué podemos ayudarte con este ticket?', media: null }];
    container.innerHTML = msgs.map(m => `
      <div style="background:${m.sender === 'Tú' ? 'rgba(37,99,235,0.15)' : 'rgba(255,255,255,0.03)'}; padding:8px 12px; border-radius:6px; font-size:12px; align-self:${m.sender === 'Tú' ? 'flex-end' : 'flex-start'}; max-width:85%;">
        <b>${esc(m.sender)}:</b> ${esc(m.text || '')}
        ${m.media ? m.media : ''}
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  $('#attachMediaBtn')?.addEventListener('click', () => {
    $('#chatMediaFile').click();
  });

  $('#sendChatMessageBtn')?.addEventListener('click', () => {
    const text = $('#chatInputMessage').value.trim();
    const fileInput = $('#chatMediaFile');
    if (!text && fileInput.files.length === 0) return;

    let mediaHtml = null;
    if (fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const fileUrl = URL.createObjectURL(file);
      if (file.type.startsWith('image/')) {
        mediaHtml = `<img src="${fileUrl}" style="max-width:100%; max-height:200px; border-radius:4px; margin-top:4px;">`;
      } else if (file.type.startsWith('video/')) {
        mediaHtml = `<video src="${fileUrl}" controls style="max-width:100%; max-height:200px; border-radius:4px; margin-top:4px;"></video>`;
      } else {
        mediaHtml = `<div style="font-size:11px; color:var(--accent);">Archivo adjunto: ${file.name}</div>`;
      }
    }

    const ticket = myTickets.find(t => t.id === activeChatTicketId);
    if (ticket) {
      if (!ticket.messages) ticket.messages = [];
      ticket.messages.push({ sender: 'Tú', text, media: mediaHtml });
    }

    $('#chatInputMessage').value = '';
    fileInput.value = '';
    loadChatMessages(activeChatTicketId);
    toast('Mensaje enviado.');
  });

  /* ───── Perfil y Cambio de Apodo Único ───── */

  function initProfileData() {
    if (!currentUser) return;
    const usernameInput = $('#profileUsername');
    const displayInput = $('#profileDisplayName');
    const passBox = $('#passwordChangeBox');
    
    if (usernameInput) usernameInput.value = currentUser.username || '';
    if (displayInput) displayInput.value = currentUser.displayName || currentUser.username || '';

    if (currentUser.usernameChanged) {
      if (displayInput) displayInput.disabled = true;
      if (passBox) passBox.style.display = 'none';
    }
  }

  $('#profileAvatarFile')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function(evt) {
        const base64 = evt.target.result;
        const preview = $('#profileAvatarPreview');
        if (preview) preview.innerHTML = `<img src="${base64}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;">`;
        if (currentUser) currentUser.avatarUrl = base64;
      };
      reader.readAsDataURL(file);
    }
  });

  $('#saveProfileBtn')?.addEventListener('click', () => {
    const newDisplayName = $('#profileDisplayName').value.trim();
    const password = $('#profileCurrentPassword')?.value.trim() || '';

    if (!newDisplayName) {
      toast('El apodo no puede estar vacío.', true);
      return;
    }

    if (currentUser && !currentUser.usernameChanged) {
      if (!password) {
        toast('Debes ingresar tu contraseña actual para confirmar el cambio de apodo.', true);
        return;
      }
      currentUser.usernameChanged = true;
      currentUser.displayName = newDisplayName;
      const displayInput = $('#profileDisplayName');
      const passBox = $('#passwordChangeBox');
      if (displayInput) displayInput.disabled = true;
      if (passBox) passBox.style.display = 'none';
    } else if (currentUser) {
      currentUser.displayName = newDisplayName;
    }

    updateUserUI();
    toast('Perfil de sobreviviente actualizado correctamente.');
  });

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

  function renderAnnouncementCard(ann) {
    const authorName = ann.author?.displayName || ann.author?.username || '—';
    const sections = (ann.sections || [])
      .map((s) => `<span class="ann-section">${esc(s)}</span>`)
      .join('');
    const staffBadge = ['admin', 'dev'].includes(ann.author?.role)
      ? `<span class="ann-staff">${esc(ann.author.role)}</span>`
      : '';
    const actions = ann.canEdit
      ? `<div class="ann-admin">
          <button type="button" class="btn-ghost sm" data-edit="${ann.id}">Editar</button>
          <button type="button" class="btn-ghost sm danger" data-del="${ann.id}">Eliminar</button>
        </div>`
      : '';

    return `
      <article class="announcement-card${ann.pinned ? ' pinned' : ''}" data-ann="${ann.id}">
        <div class="feed-card-top" style="display:flex; align-items:center; gap:10px;">
          <div class="avatar" style="width:36px;height:36px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;background:${avatarColor(authorName)}">${esc(initials(authorName))}</div>
          <div class="feed-meta" style="flex:1;">
            <div class="feed-author" style="display:flex; align-items:center; gap:6px;">
              <b>${esc(authorName)}</b>
              ${staffBadge}
              ${ann.pinned ? '<span class="ann-pin">📌</span>' : ''}
            </div>
            <div class="feed-sub" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11.5px; color:var(--muted);">
              <span class="announcement-badge">${esc(ann.category)}</span>
              ${sections}
              <span class="announcement-date">· ${esc(formatDate(ann.createdAt))}</span>
            </div>
          </div>
          ${actions}
        </div>
        <h3 class="feed-title" style="margin-top:6px; font-size:15px; font-weight:700;">${esc(ann.title)}</h3>
        <p class="ann-body" style="font-size:12.5px; line-height:1.4; color:var(--text);">${esc(ann.content).replace(/\n/g, '<br>')}</p>
        ${mediaHtml(ann)}
        ${reactionsHtml(ann)}
        <div class="feed-actions" style="display:flex; gap:12px; margin-top:4px;">
          <button type="button" class="feed-action" data-toggle-comments="${ann.id}" style="background:none; border:0; color:var(--text-2); cursor:pointer; font-size:12px;">
            💬 <span>${ann.commentCount || 0}</span> comentarios
          </button>
          <button type="button" class="feed-action" data-open-emoji="${ann.id}" style="background:none; border:0; color:var(--text-2); cursor:pointer; font-size:12px;">😊 Reaccionar</button>
        </div>
        <div class="ann-comments" id="comments-${ann.id}" hidden style="margin-top:8px; border-top:1px solid var(--border); padding-top:8px;"></div>
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
    const keepOpen = new Set(expandedComments);
    grid.innerHTML = res.data.map(renderAnnouncementCard).join('');
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

  function renderCommentNode(c, annId) {
    const name = c.author.displayName || c.author.username;
    const kids = (c.children || []).map((ch) => renderCommentNode(ch, annId)).join('');
    return `
      <div class="comment" data-cmt="${c.id}" style="margin-left:${Math.min(c.depth || 0, 4) * 12}px; margin-top:6px;">
        <div style="display:flex; gap:8px; align-items:flex-start;">
          <div class="avatar sm" style="width:28px;height:28px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700;background:${avatarColor(name)}">${esc(initials(name))}</div>
          <div style="flex:1; background:rgba(255,255,255,0.02); padding:6px 10px; border-radius:6px;">
            <div style="display:flex; justify-content:space-between; font-size:11px;">
              <b>${esc(name)}</b>
              <span class="muted">${esc(formatDate(c.createdAt))}</span>
            </div>
            <p style="font-size:12px; margin-top:2px;">${esc(c.content)}</p>
          </div>
        </div>
        ${kids ? `<div style="margin-top:4px;">${kids}</div>` : ''}
      </div>`;
  }

  async function toggleComments(annId) {
    const box = $(`#comments-${annId}`);
    if (!box) return;
    if (!box.hidden && expandedComments.has(annId)) {
      box.hidden = true;
      expandedComments.delete(annId);
      return;
    }
    expandedComments.add(annId);
    box.hidden = false;
    box.innerHTML = `<p class="muted pad-sm">Cargando comentarios…</p>`;
    const res = await api.getComments(annId);
    if (!res.ok) {
      box.innerHTML = `<p class="muted pad-sm">${esc(res.error || 'Error')}</p>`;
      return;
    }
    const tree = buildCommentTree(res.data || []);
    const list = tree.length
      ? tree.map((c) => renderCommentNode(c, annId)).join('')
      : `<p class="muted pad-sm" style="font-size:11.5px; color:var(--muted);">Sé el primero en comentar.</p>`;

    box.innerHTML = `
      <div class="comment-list" style="display:flex; flex-direction:column; gap:6px;">${list}</div>
      <div class="comment-composer" style="display:flex; gap:6px; margin-top:8px;">
        <input class="input" id="cmt-input-${annId}" maxlength="1000" placeholder="Escribí un comentario…" style="flex:1;">
        <button type="button" class="btn-primary sm" data-send-cmt="${annId}">Publicar</button>
      </div>`;

    box.querySelector(`[data-send-cmt="${annId}"]`)?.addEventListener('click', async () => {
      const input = $(`#cmt-input-${annId}`);
      const text = input?.value.trim();
      if (!text) return;
      const r = await api.postComment(annId, text, null);
      if (!r.ok) toast(r.error || 'Error', 'error');
      else {
        expandedComments.delete(annId);
        await toggleComments(annId);
        await loadAnnouncements();
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
    setupPostModal();

    if (!api) {
      toast('Error interno: no se pudo conectar con la aplicación.', 'error');
      return;
    }

    const boot = await api.boot();
    CFG = boot.config;
    SET = boot.settings;
    currentUser = boot.user || null;
    if ($('#appVer')) $('#appVer').textContent = `v${boot.version}`;

    applyBranding();
    renderRules();
    renderNews();
    renderStore();
    renderTickets();
    setupPlay();
    setupSettings();
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