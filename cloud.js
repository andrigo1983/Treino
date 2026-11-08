'use strict';
/* Classic 8 Cloud. Banco protegido por Supabase Auth + RLS. Sem segredos no frontend. */
(() => {
  const cfg = window.CLASSIC8_SUPABASE || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(cfg.url || '') &&
    /^(sb_publishable_|eyJ)/.test(cfg.publishableKey || '') &&
    !cfg.publishableKey.includes('SUBSTITUA');
  let client = null;
  if (configured && window.supabase?.createClient) {
    client = window.supabase.createClient(cfg.url, cfg.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }
  let currentUser = null;
  let revision = 0;
  let dirty = false;
  let busy = false;
  let conflicted = false;
  let cloudError = '';
  let scheduleTimer = null;
  let generation = 0;
  let mode = 'login';
  const localKey = () => currentUser ? `classic8-cloud-${currentUser.id}` : 'classic8-data-v1';
  const revKey = () => `${localKey()}-revision`;
  const dirtyKey = () => `${localKey()}-dirty`;
  const ownerKey = 'classic8-last-cloud-account';
  const userLabel = () => currentUser ? esc(currentUser.email || 'Conta autenticada') : '';
  const hasRecords = x => Object.keys(x?.logs || {}).length > 0 || Object.keys(x?.measurements || {}).length > 0;
  const isValid = x => x && x.version === 1 && x.logs && x.measurements && x.profile &&
    typeof x.logs === 'object' && typeof x.measurements === 'object' && typeof x.profile === 'object';
  function setBadge(text, cls = '') {
    const el = document.querySelector('#connection span:last-child');
    if (el) el.textContent = text;
    const pill = document.querySelector('#connection');
    if (pill) pill.title = text;
  }
  function status() {
    if (!configured) return 'Configuração necessária';
    if (!client) return 'Biblioteca de conexão indisponível';
    if (!currentUser) return 'Não conectado';
    if (!navigator.onLine) return 'Offline · salvo no aparelho';
    if (conflicted) return 'Conflito · escolha uma versão';
    if (busy) return 'Sincronizando…';
    if (dirty) return 'Pendente de sincronização';
    if (cloudError) return 'Falha: ' + cloudError;
    return 'Nuvem sincronizada';
  }
  function updateStatus() {
    const s = status();
    setBadge(s);
    const el = document.getElementById('cloud-status');
    if (el) el.textContent = s;
    const c = document.getElementById('cloud-conflict');
    if (c) c.hidden = !conflicted;
  }
  function panel() {
    if (!configured) return `<section class="card"><h2 class="card-title">Ativar banco de dados</h2>
      <p>Para usar a nuvem, crie um projeto Supabase, execute <code>database.sql</code> e preencha a URL e a chave <b>publishable</b> no arquivo <code>config.js</code>. Consulte o README incluído no pacote.</p>
      <p class="cloud-note">O aplicativo continua utilizável offline, com dados somente neste aparelho, até essa configuração ser concluída.</p></section>`;
    if (!client) return `<section class="card"><h2 class="card-title">Conexão indisponível</h2><p>O módulo Supabase ainda não carregou. Conecte-se à internet e recarregue a página.</p></section>`;
    if (!currentUser) return `<section class="card"><h2 class="card-title">Minha conta na nuvem</h2>
      <p>Entre com e-mail e senha para sincronizar seus treinos e medidas com o banco de dados privado.</p>
      <form id="cloud-auth-form" class="cloud-grid" autocomplete="on">
        <div><label for="cloud-email">E-mail</label><input id="cloud-email" type="email" autocomplete="email" required maxlength="254" placeholder="seu@email.com"></div>
        <div><label for="cloud-password">Senha</label><input id="cloud-password" type="password" autocomplete="${mode === 'signup'?'new-password':'current-password'}" required minlength="6" placeholder="Mínimo 6 caracteres"></div>
        <button class="btn primary" type="submit">${mode === 'signup' ? 'Criar conta' : 'Entrar e sincronizar'}</button>
      </form>
      <div class="cloud-actions"><button class="btn small" id="cloud-toggle-mode">${mode === 'signup' ? 'Já tenho conta' : 'Criar uma conta'}</button></div>
      <p class="cloud-note">Se a confirmação de e-mail estiver habilitada no Supabase, será necessário confirmar o cadastro antes de entrar. Seus dados ficam protegidos pela autenticação e por RLS.</p></section>`;
    return `<section class="card"><h2 class="card-title">Banco de dados conectado</h2>
      <p class="cloud-email">${userLabel()}</p><div class="cloud-pill ${dirty || conflicted ? 'pending' : 'synced'}" id="cloud-status">${esc(status())}</div>
      <p class="cloud-note">Os treinos e medidas são gravados no aparelho e sincronizados quando você está online. O código hospedado no GitHub não contém seus registros.</p>
      <div class="cloud-actions">
        <button class="btn primary" id="cloud-sync" type="button">Sincronizar agora</button>
        <button class="btn" id="cloud-pull" type="button">Baixar dados da nuvem</button>
        <button class="btn" id="cloud-signout" type="button">Sair da conta</button>
      </div>
      <div id="cloud-conflict" class="cloud-alert" ${conflicted?'':'hidden'}>
        Outra versão dos dados foi encontrada no banco. Por segurança, a sincronização foi pausada. Exporte um backup JSON antes de decidir.
        <div class="cloud-actions"><button id="cloud-use-remote" class="btn">Usar versão da nuvem</button><button id="cloud-use-local" class="btn danger">Substituir nuvem pela versão local</button></div>
      </div>
      <p class="cloud-note">Para evitar conflitos, não edite o mesmo treino em dois dispositivos simultaneamente. Se a sincronização estiver pendente, não limpe os dados do navegador.</p>
    </section>`;
  }
  function redrawPanel() {
    const holder = document.getElementById('cloud-account');
    if (holder) { holder.innerHTML = panel(); bind(); }
    updateStatus();
  }
  function persistState() {
    if (!currentUser) return;
    localStorage.setItem(revKey(), String(revision));
    localStorage.setItem(dirtyKey(), dirty ? '1' : '0');
  }
  function changed() {
    if (!currentUser) return;
    dirty = true;
    cloudError = '';
    persistState();
    updateStatus();
    queue();
  }
  function queue() {
    clearTimeout(scheduleTimer);
    if (currentUser && dirty && !conflicted && navigator.onLine) scheduleTimer = setTimeout(() => { sync(); }, 1500);
  }
  async function getRemote() {
    const {data:row,error} = await client.from('classic8_state').select('payload,revision').eq('user_id', currentUser.id).maybeSingle();
    if (error) throw error;
    return row;
  }
  function receiveRemote(row) {
    if (!row || !isValid(row.payload)) throw Error('Dados remotos inválidos');
    data = row.payload;
    revision = Number(row.revision);
    dirty = false;
    conflicted = false;
    cloudError = '';
    localStorage.setItem(STORE, JSON.stringify(data));
    persistState();
    render();
    redrawPanel();
  }
  async function sync() {
    if (!client || !currentUser || busy || conflicted || !navigator.onLine) { updateStatus(); return; }
    const thisGeneration = generation;
    busy = true;
    cloudError = '';
    updateStatus();
    try {
      const remote = await getRemote();
      if (thisGeneration !== generation) return;
      const remoteRev = remote ? Number(remote.revision) : 0;
      if (!dirty) {
        if (remote && remoteRev !== revision) receiveRemote(remote);
        return;
      }
      if (remoteRev !== revision) {
        conflicted = true;
        cloudError = 'Outra versão foi encontrada';
        return;
      }
      const snapshot = JSON.stringify(data);
      if (snapshot.length > 1500000) throw Error('Backup muito grande para sincronizar');
      const {data:newRev,error} = await client.rpc('classic8_save', {
        p_payload: JSON.parse(snapshot), p_expected_revision: revision
      });
      if (error) throw error;
      if (Number(newRev) < 1) { conflicted = true; return; }
      if (thisGeneration !== generation) return;
      revision = Number(newRev);
      dirty = JSON.stringify(data) !== snapshot;
      persistState();
      cloudError = '';
      if (dirty) queue();
    } catch (e) {
      cloudError = e.message || 'Não foi possível sincronizar';
      console.warn('Classic8 cloud:', e);
    } finally {
      busy = false;
      redrawPanel();
    }
  }
  async function useRemote() {
    if (!currentUser || !navigator.onLine) return;
    if (dirty && !confirm('Substituir os registros locais pelos da nuvem? Exporte um backup JSON antes.')) return;
    try {
      const remote = await getRemote();
      if (!remote) return alert('Ainda não há dados no banco.');
      receiveRemote(remote);
      toast('Dados recuperados da nuvem');
    } catch(e) { alert('Erro ao baixar dados: '+e.message); }
  }
  async function overwriteRemote() {
    if (!currentUser || !navigator.onLine) return;
    if (!confirm('Substituir os dados da NUVEM pelos deste aparelho? Esta ação pode apagar mudanças feitas em outros dispositivos. Faça backup primeiro.')) return;
    try {
      const remote = await getRemote();
      revision = remote ? Number(remote.revision) : 0;
      conflicted = false;
      dirty = true;
      persistState();
      await sync();
    } catch(e) { alert('Erro: '+e.message); }
  }
  async function attachUser(user) {
    if (!user || currentUser?.id === user.id) return;
    ++generation;
    clearTimeout(scheduleTimer);
    const previousOwner = localStorage.getItem(ownerKey);
    const originalData = data;
    currentUser = user;
    STORE = localKey();
    revision = Number(localStorage.getItem(revKey()) || 0);
    dirty = localStorage.getItem(dirtyKey()) === '1';
    conflicted = false;
    cloudError = '';
    const stored = localStorage.getItem(STORE);
    if (stored) {
      data = load();
    } else if (!previousOwner && hasRecords(originalData)) {
      // Migração segura: dados antigos do navegador, somente para o primeiro usuário que entrar.
      data = originalData;
      dirty = true;
      localStorage.setItem(STORE, JSON.stringify(data));
      persistState();
    } else {
      data = initial();
    }
    localStorage.setItem(ownerKey, user.id);
    render();
    redrawPanel();
    if (!navigator.onLine) { updateStatus(); return; }
    try {
      const remote = await getRemote();
      if (!remote) {
        if (dirty || hasRecords(data)) {
          dirty = true;
          persistState();
          await sync();
        }
      } else if (dirty && Number(remote.revision) !== revision) {
        conflicted = true;
      } else if (!dirty || Number(remote.revision) !== revision) {
        receiveRemote(remote);
      } else await sync();
    } catch(e) { cloudError = e.message || 'Erro de conexão'; }
    redrawPanel();
  }
  async function signOut() {
    if (!client) return;
    if (dirty && !confirm('Há dados pendentes de sincronização. Sair agora manterá os dados somente neste aparelho. Deseja continuar?')) return;
    try { const {error} = await client.auth.signOut(); if (error) throw error; detachUser(); }
    catch(e) { alert('Erro ao sair: '+e.message); }
  }
  function detachUser() {
    ++generation;
    clearTimeout(scheduleTimer);
    currentUser = null;
    STORE = 'classic8-data-v1';
    data = load();
    revision = 0; dirty = false; busy = false; conflicted = false; cloudError = '';
    render();
    redrawPanel();
  }
  function bind() {
    document.getElementById('cloud-toggle-mode')?.addEventListener('click', () => {
      mode = mode === 'login' ? 'signup' : 'login'; redrawPanel();
    });
    document.getElementById('cloud-auth-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const email = document.getElementById('cloud-email').value.trim();
      const password = document.getElementById('cloud-password').value;
      const button = e.currentTarget.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        if (mode === 'signup') {
          const {data:created,error} = await client.auth.signUp({email,password});
          if (error) throw error;
          if (!created.session) alert('Cadastro recebido. Confira seu e-mail para confirmar a conta e depois entre.');
          else toast('Conta criada e conectada');
        } else {
          const {error} = await client.auth.signInWithPassword({email,password});
          if (error) throw error;
          toast('Login realizado');
        }
      } catch(err) { alert('Falha de autenticação: '+err.message); }
      finally { button.disabled = false; }
    });
    document.getElementById('cloud-sync')?.addEventListener('click', async () => {
      if (!dirty) { try { const remote=await getRemote(); if (remote && Number(remote.revision)!==revision) receiveRemote(remote); else toast('Dados atualizados'); } catch(e) { alert(e.message); } }
      else await sync();
      redrawPanel();
    });
    document.getElementById('cloud-pull')?.addEventListener('click', useRemote);
    document.getElementById('cloud-use-remote')?.addEventListener('click', useRemote);
    document.getElementById('cloud-use-local')?.addEventListener('click', overwriteRemote);
    document.getElementById('cloud-signout')?.addEventListener('click', signOut);
  }
  window.classicCloud = { panel, bind, changed, sync };
  redrawPanel();
  window.addEventListener('online', () => { redrawPanel(); if (currentUser) sync(); });
  window.addEventListener('offline', redrawPanel);
  if (client) {
    client.auth.onAuthStateChange((event, session) => {
      // Supabase recomenda não aguardar chamadas à API dentro do callback de autenticação.
      setTimeout(() => {
        if (session?.user) attachUser(session.user);
        else if (event === 'SIGNED_OUT' && currentUser) detachUser();
      }, 0);
    });
    client.auth.getSession().then(({data:auth,error}) => {
      if (error) { cloudError = error.message; redrawPanel(); }
      if (auth?.session?.user) attachUser(auth.session.user);
    }).catch(e => { cloudError=e.message; redrawPanel(); });
  }
})();
