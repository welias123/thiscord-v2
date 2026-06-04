'use strict';

// ── Auth guard ────────────────────────────────────────────────────────
const token = localStorage.getItem('tc-token');
if (!token) { location.href = '/'; }

let me = JSON.parse(localStorage.getItem('tc-user') || '{}');

// ── State ─────────────────────────────────────────────────────────────
let socket, channels = [], onlineSet = new Set(), allUsers = new Map();
let activeView = null; // { type: 'channel'|'dm', id, name }
let typingTimer = null, rpTab = 'online';
const COLORS = ['#7c3aed','#a855f7','#ec4899','#06b6d4','#10b981','#f59e0b','#ef4444','#3b82f6'];
let selectedColor = me.avatar_color || COLORS[0];

// ── API helper ────────────────────────────────────────────────────────
async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Fehler');
  return d;
}

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  // Retry up to 5x if server is momentarily restarting
  let tries = 0;
  while (true) {
    try {
      me = await api('GET', '/api/me');
      localStorage.setItem('tc-user', JSON.stringify(me));
      break;
    } catch(e) {
      tries++;
      if (tries >= 5) { logout(); return; }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  updateMyPanel();
  document.getElementById('app').style.display = 'flex';

  await loadChannels();
  await loadVoiceChannels();
  connectSocket();
  loadRightPanel();
}

function updateMyPanel() {
  const av = document.getElementById('my-avatar');
  const sa = document.getElementById('settings-avatar');
  av.textContent = me.username[0].toUpperCase();
  av.style.background = me.avatar_color || COLORS[0];
  if (sa) { sa.textContent = av.textContent; sa.style.background = av.style.background; }
  document.getElementById('my-name').textContent = me.username;
  document.getElementById('my-tag').textContent = me.email || '';
  if (document.getElementById('settings-name-disp')) {
    document.getElementById('settings-name-disp').textContent = me.username;
    document.getElementById('settings-email-disp').textContent = me.email || '';
    document.getElementById('set-username').value = me.username;
    document.getElementById('set-bio').value = me.bio || '';
  }
}

// ── Voice ─────────────────────────────────────────────────────────────
let localStream = null, peers = {}, micMuted = false, inVoice = false, currentVoiceRoom = null;

async function joinVoice(room) {
  if (inVoice && currentVoiceRoom === room) return;
  if (inVoice) leaveVoice();
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    toast('Kein Mikrofon gefunden oder Zugriff verweigert!', 'error'); return;
  }
  inVoice = true; currentVoiceRoom = room;
  document.getElementById('voice-bar').style.display = 'flex';
  document.getElementById('voice-room-name').textContent = room;
  socket.emit('voice-join', { room });
  renderVoiceChannels();
}

function leaveVoice() {
  if (!inVoice) return;
  socket.emit('voice-leave');
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  Object.values(peers).forEach(p => p.close());
  peers = {};
  inVoice = false; currentVoiceRoom = null;
  document.getElementById('voice-bar').style.display = 'none';
  renderVoiceChannels();
}

function toggleMute() {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !micMuted);
  document.getElementById('mute-btn').textContent = micMuted ? '🔇 Stummgeschaltet' : '🎤 Stummschalten';
}

function createPeer(socketId, initiator) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => { if (e.candidate) socket.emit('voice-signal', { to: socketId, signal: { type: 'candidate', candidate: e.candidate } }); };
  pc.ontrack = e => {
    const audio = document.createElement('audio');
    audio.srcObject = e.streams[0]; audio.autoplay = true;
    audio.id = `audio-${socketId}`; document.body.appendChild(audio);
  };
  if (initiator) {
    pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => {
      socket.emit('voice-signal', { to: socketId, signal: { type: 'offer', sdp: pc.localDescription } });
    });
  }
  peers[socketId] = pc; return pc;
}

function setupVoiceSocket() {
  socket.on('voice-members', (members) => {
    // Existing members: we initiate offers to them
    members.forEach(m => { if (m.socketId !== socket.id) createPeer(m.socketId, true); });
  });

  socket.on('voice-user-joined', (m) => {
    // New user joined: they will offer to us, we just wait
  });

  socket.on('voice-user-left', ({ userId }) => {
    Object.entries(peers).forEach(([sid, pc]) => {
      // We don't know socketId from userId easily — just clean up all and rely on re-offer
    });
    document.querySelectorAll('[id^="audio-"]').forEach(a => {});
    renderVoiceChannels();
  });

  socket.on('voice-signal', async ({ from, signal }) => {
    if (!inVoice) return;
    let pc = peers[from];
    if (!pc) { pc = createPeer(from, false); }
    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('voice-signal', { to: from, signal: { type: 'answer', sdp: pc.localDescription } });
    } else if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'candidate') {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
    }
  });

  socket.on('voice-state', (state) => {
    Object.assign(window._voiceState = window._voiceState || {}, state);
    renderVoiceChannels();
  });
}

async function loadVoiceChannels() {
  const data = await api('GET', '/api/voice-channels');
  window._voiceState = {};
  data.forEach(ch => { window._voiceState[ch.name] = ch.members; });
  renderVoiceChannels();
}

function renderVoiceChannels() {
  const state = window._voiceState || {};
  const list = document.getElementById('voice-channel-list');
  if (!list) return;
  list.innerHTML = Object.entries(state).map(([name, members]) => `
    <div class="voice-channel-item${currentVoiceRoom===name?' active':''}" onclick="joinVoice('${esc(name)}')">
      <div class="voice-channel-header"><span>🔊</span><span>${esc(name)}</span></div>
      ${members.length ? `<div class="voice-members-list">${members.map(m=>`<div class="voice-member-entry">${esc(m.username)}</div>`).join('')}</div>` : ''}
    </div>`).join('');
}

// ── Channels ──────────────────────────────────────────────────────────
async function loadChannels() {
  channels = await api('GET', '/api/channels');
  const list = document.getElementById('channel-list');
  list.innerHTML = channels.map(ch => `
    <div class="channel-item" id="ch-item-${ch.id}" onclick="openChannel(${ch.id},'${esc(ch.name)}')">
      <span class="channel-icon">#</span>
      <span>${esc(ch.name)}</span>
    </div>`).join('');
}

async function openChannel(id, name) {
  activeView = { type:'channel', id, name };
  setActiveItem(`ch-item-${id}`);
  showHeader('#', `#${name}`, '');
  showChatUI();
  document.getElementById('msg-input').placeholder = `Nachricht an #${name}`;
  socket?.emit('join-channel', id);
  const msgs = await api('GET', `/api/messages/${id}`);
  renderMessages(msgs);
}

// ── DMs ───────────────────────────────────────────────────────────────
async function loadDMs() {
  const friends = await api('GET', '/api/friends');
  const accepted = friends.filter(f => f.status === 'accepted');
  const list = document.getElementById('dm-list');
  list.innerHTML = accepted.map(f => `
    <div class="dm-item" id="dm-item-${f.uid}" onclick="openDM(${f.uid},'${esc(f.username)}','${esc(f.avatar_color)}')">
      <div class="dm-avatar" style="background:${f.avatar_color}">
        ${f.username[0].toUpperCase()}
        <span class="status-dot ${onlineSet.has(f.uid) ? 'online' : ''}"></span>
      </div>
      <span>${esc(f.username)}</span>
    </div>`).join('') || '<div style="color:var(--muted);font-size:12px;padding:6px 12px">Noch keine Freunde</div>';
}

async function openDM(uid, name, color) {
  activeView = { type:'dm', id: uid, name };
  setActiveItem(`dm-item-${uid}`);
  showHeader('💬', name, '');
  showChatUI();
  document.getElementById('msg-input').placeholder = `Nachricht an ${name}`;
  const msgs = await api('GET', `/api/dm/${uid}`);
  renderMessages(msgs, true);
}

// ── Message rendering ─────────────────────────────────────────────────
function buildMsgHTML(m, grouped, isDM) {
  const date = new Date(m.created_at * 1000);
  const timeStr = date.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' });
  const uid = isDM ? m.sender_id : m.user_id;
  const isMe = uid === me.id;
  const chId = isDM ? null : m.channel_id;
  const bio  = m.bio || '';
  return `
    <div class="msg${grouped?' msg-grouped':''}" data-msg-id="${m.id}">
      ${grouped ? `<span class="msg-time-small">${timeStr}</span>` : ''}
      <div class="msg-avatar" style="background:${m.avatar_color};cursor:pointer"
           onclick="showProfile(${uid},'${esc(m.username)}','${m.avatar_color}','${esc(bio)}',${m.created_at||0},this)">
        ${grouped ? '' : m.username[0].toUpperCase()}
      </div>
      <div class="msg-body">
        ${grouped ? '' : `<div class="msg-header">
          <span class="msg-author" style="color:${m.avatar_color};cursor:pointer"
                onclick="showProfile(${uid},'${esc(m.username)}','${m.avatar_color}','${esc(bio)}',${m.created_at||0},this)">
            ${esc(m.username)}
          </span>
          <span class="msg-time">${timeStr}</span>
          ${m.edited ? '<span class="msg-edited">(bearbeitet)</span>' : ''}
        </div>`}
        <div class="msg-content">${esc(m.content)}</div>
        ${renderReactions(m.reactions, m.id, chId)}
      </div>
      ${!isDM ? `<div class="msg-actions">
        <button class="msg-action-btn" title="Reaktion" onclick="toggleEmojiPicker(${m.id},${chId},this)">😊</button>
        ${isMe ? `<button class="msg-action-btn" title="Bearbeiten" onclick="editMessage(${m.id},${chId})">✏️</button>
        <button class="msg-action-btn danger" title="Löschen" onclick="deleteMessage(${m.id},${chId})">🗑️</button>` : ''}
      </div>` : ''}
    </div>`;
}

function renderMessages(msgs, isDM = false) {
  const area = document.getElementById('messages-area');
  if (!msgs.length) { area.innerHTML = '<div class="day-divider">Noch keine Nachrichten</div>'; return; }

  let lastAuthor = null, lastDate = null, html = '';
  msgs.forEach(m => {
    const date = new Date(m.created_at * 1000);
    const dateStr = date.toLocaleDateString('de-DE', { day:'numeric', month:'long', year:'numeric' });
    if (dateStr !== lastDate) { html += `<div class="day-divider">${dateStr}</div>`; lastDate = dateStr; lastAuthor = null; }
    const grouped = m.username === lastAuthor;
    html += buildMsgHTML(m, grouped, isDM);
    lastAuthor = m.username;
  });
  area.innerHTML = html;
  area.scrollTop = area.scrollHeight;
}

function appendMessage(m, isDM = false) {
  const area = document.getElementById('messages-area');
  const last = area.querySelector('.msg:last-child');
  const lastAuthor = last?.querySelector('.msg-author')?.textContent?.trim();
  const grouped = lastAuthor === m.username;
  const div = document.createElement('div');
  div.innerHTML = buildMsgHTML(m, grouped, isDM);
  area.appendChild(div.firstElementChild);
  area.scrollTop = area.scrollHeight;
}

// ── Send ──────────────────────────────────────────────────────────────
function sendMessage() {
  const inp = document.getElementById('msg-input');
  const content = inp.value.trim();
  if (!content || !activeView) return;
  if (activeView.type === 'channel') socket.emit('message', { channelId: activeView.id, content });
  else socket.emit('dm', { toUserId: activeView.id, content });
  inp.value = ''; inp.style.height = '';
}

// ── Socket ────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('connect_error', (e) => {
    if (e.message === 'Unauthorized') logout();
  });

  socket.on('message', (m) => {
    if (activeView?.type === 'channel' && activeView.id === m.channel_id) appendMessage(m);
  });

  socket.on('dm', (m) => {
    const otherId = m.sender_id === me.id ? m.receiver_id : m.sender_id;
    if (activeView?.type === 'dm' && activeView.id === otherId) appendMessage(m, true);
    else if (m.sender_id !== me.id) toast(`💬 DM von ${m.username}: ${m.content.slice(0,60)}`, 'info');
  });

  socket.on('typing', ({ username, channelId }) => {
    if (activeView?.type !== 'channel' || activeView.id !== channelId) return;
    showTyping(`${username} schreibt…`);
  });

  socket.on('dm-typing', ({ from }) => {
    if (activeView?.type !== 'dm') return;
    showTyping(`${from} schreibt…`);
  });

  socket.on('user-status', ({ userId, online }) => {
    if (online) onlineSet.add(userId); else onlineSet.delete(userId);
    loadRightPanel();
    loadDMs();
  });

  setupVoiceSocket();

  socket.on('friend-request', ({ from }) => {
    toast(`👋 Freundschaftsanfrage von ${from.username}!`, 'info');
    loadDMs();
  });

  socket.on('message-edited', ({ id, content }) => {
    const el = document.querySelector(`[data-msg-id="${id}"] .msg-content`);
    if (el) { el.innerHTML = esc(content); }
    const hdr = document.querySelector(`[data-msg-id="${id}"] .msg-header`);
    if (hdr && !hdr.querySelector('.msg-edited')) hdr.insertAdjacentHTML('beforeend','<span class="msg-edited">(bearbeitet)</span>');
  });

  socket.on('message-deleted', ({ id }) => {
    document.querySelector(`[data-msg-id="${id}"]`)?.remove();
  });

  socket.on('message-reaction', ({ id, reactions }) => {
    const el = document.querySelector(`[data-msg-id="${id}"]`);
    if (!el) return;
    const chId = activeView?.id;
    let reactEl = el.querySelector('.msg-reactions');
    const newHTML = renderReactions(reactions, id, chId);
    if (reactEl) reactEl.outerHTML = newHTML || '';
    else if (newHTML) el.querySelector('.msg-body')?.insertAdjacentHTML('beforeend', newHTML);
  });

  socket.on('friend-accepted', ({ by }) => {
    toast(`🎉 ${by.username} hat deine Anfrage angenommen!`, 'success');
    loadDMs();
  });
}

// ── Typing ────────────────────────────────────────────────────────────
let typingTimeout = null;
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('msg-input');
  inp.addEventListener('input', () => {
    if (!activeView) return;
    if (activeView.type === 'channel') socket?.emit('typing', { channelId: activeView.id });
    else socket?.emit('dm-typing', { toUserId: activeView.id });
    inp.style.height = ''; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
});

function showTyping(txt) {
  const el = document.getElementById('typing-indicator');
  el.style.display = ''; el.textContent = txt;
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { el.style.display = 'none'; el.textContent = ''; }, 2500);
}

// ── Right Panel ───────────────────────────────────────────────────────
async function loadRightPanel() {
  const content = document.getElementById('rp-content');
  if (rpTab === 'online') {
    // Show online users from allUsers, or just from onlineSet
    content.innerHTML = onlineSet.size
      ? [...onlineSet].map(uid => {
          const u = allUsers.get(uid) || { username:'...', avatar_color:'#7c3aed' };
          return `<div class="online-user">
            <div class="dm-avatar" style="background:${u.avatar_color};width:28px;height:28px;font-size:12px">${u.username[0]?.toUpperCase()}</div>
            <div><div class="online-user-name">${esc(u.username)}</div><div class="online-user-status">● Online</div></div>
          </div>`;
        }).join('')
      : '<div style="color:var(--muted);font-size:13px;padding:8px">Niemand online</div>';
  }
}

function switchRpTab(tab) {
  rpTab = tab;
  document.getElementById('rp-tab-online').classList.toggle('active', tab==='online');
  document.getElementById('rp-tab-members').classList.toggle('active', tab==='members');
  loadRightPanel();
}

// ── Friends Modal ─────────────────────────────────────────────────────
async function openFriends() {
  document.getElementById('modal-friends').style.display = 'flex';
  document.getElementById('friend-err').style.display = 'none';
  document.getElementById('friend-suc').style.display = 'none';
  await refreshFriends();
}

async function refreshFriends() {
  const friends = await api('GET', '/api/friends');
  const pending = friends.filter(f => f.status === 'pending' && f.receiver_id === me.id);
  const accepted = friends.filter(f => f.status === 'accepted');

  const ps = document.getElementById('pending-section');
  const pl = document.getElementById('pending-list');
  ps.style.display = pending.length ? '' : 'none';
  pl.innerHTML = pending.map(f => `
    <div class="friend-item">
      <div class="dm-avatar" style="background:${f.avatar_color};width:30px;height:30px;font-size:13px">${f.username[0].toUpperCase()}</div>
      <span class="friend-name">${esc(f.username)}</span>
      <div class="friend-actions">
        <button class="icon-btn accept" title="Annehmen" onclick="acceptFriend(${f.id})">✓</button>
        <button class="icon-btn reject" title="Ablehnen" onclick="rejectFriend(${f.id})">✕</button>
      </div>
    </div>`).join('');

  const fl = document.getElementById('friends-list');
  fl.innerHTML = accepted.length
    ? accepted.map(f => `
        <div class="friend-item">
          <div class="dm-avatar" style="background:${f.avatar_color};width:30px;height:30px;font-size:13px">
            ${f.username[0].toUpperCase()}
            <span class="status-dot ${onlineSet.has(f.uid)?'online':''}"></span>
          </div>
          <span class="friend-name">${esc(f.username)}</span>
          <div class="friend-actions">
            <button class="icon-btn" title="Nachricht" onclick="closeModal('modal-friends');openDM(${f.uid},'${esc(f.username)}','${esc(f.avatar_color)}')">💬</button>
            <button class="icon-btn reject" title="Entfernen" onclick="removeFriend(${f.id})">✕</button>
          </div>
        </div>`).join('')
    : '<div style="color:var(--muted);font-size:13px;padding:8px">Noch keine Freunde 😢</div>';

  await loadDMs();
}

async function sendFriendRequest() {
  const username = document.getElementById('add-friend-input').value.trim();
  if (!username) return;
  try {
    await api('POST', '/api/friends/add', { username });
    document.getElementById('friend-suc').textContent = `Anfrage an ${username} gesendet!`;
    document.getElementById('friend-suc').style.display = 'block';
    document.getElementById('friend-err').style.display = 'none';
    document.getElementById('add-friend-input').value = '';
  } catch(e) {
    document.getElementById('friend-err').textContent = e.message;
    document.getElementById('friend-err').style.display = 'block';
    document.getElementById('friend-suc').style.display = 'none';
  }
}

async function acceptFriend(id) {
  await api('POST', '/api/friends/accept', { id });
  toast('Freundschaft angenommen!', 'success');
  await refreshFriends();
}
async function rejectFriend(id) {
  await api('POST', '/api/friends/reject', { id });
  await refreshFriends();
}
async function removeFriend(id) {
  await api('DELETE', `/api/friends/${id}`);
  toast('Freund entfernt.', 'info');
  await refreshFriends();
}

// ── Settings Tabs ─────────────────────────────────────────────────────
function switchSettingsTab(tab, btn) {
  ['profile','audio','status'].forEach(t => {
    document.getElementById(`settings-tab-${t}`).style.display = t===tab ? '' : 'none';
  });
  document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (tab === 'audio') loadAudioDevices();
}

// ── Status ────────────────────────────────────────────────────────────
let myStatus = 'online';
async function setStatus(status) {
  myStatus = status;
  await api('PUT', '/api/me/status', { status });
  document.querySelectorAll('.status-opt').forEach(el => el.classList.remove('active'));
  event?.target?.closest('.status-opt')?.classList.add('active');
  updateStatusDot(status);
  toast(`Status: ${statusLabel(status)}`, 'info');
}

function statusLabel(s) {
  return { online:'Online', away:'Abwesend', dnd:'Nicht stören', invisible:'Unsichtbar' }[s] || s;
}

function statusColor(s) {
  return { online:'var(--online)', away:'var(--warn)', dnd:'var(--danger)', invisible:'#666' }[s] || '#666';
}

function updateStatusDot(status) {
  const dot = document.getElementById('my-status-dot');
  if (dot) dot.style.background = statusColor(status);
}

// ── Audio Settings ────────────────────────────────────────────────────
let micTestStream = null, micTestAnim = null;
let selectedMicId = localStorage.getItem('tc-mic-id') || '';
let selectedSpeakerId = localStorage.getItem('tc-speaker-id') || '';
let micGain = Number(localStorage.getItem('tc-mic-volume') || 100);

async function loadAudioDevices() {
  try {
    // Request permission first so device labels are visible
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop()); // stop immediately, just needed for permission
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const speakers = devices.filter(d => d.kind === 'audiooutput');

    const micSel = document.getElementById('audio-mic-select');
    const spkSel = document.getElementById('audio-speaker-select');
    micSel.innerHTML = mics.map(d => `<option value="${d.deviceId}" ${d.deviceId===selectedMicId?'selected':''}>${d.label||'Mikrofon '+d.deviceId.slice(0,6)}</option>`).join('');
    spkSel.innerHTML = speakers.length
      ? speakers.map(d => `<option value="${d.deviceId}" ${d.deviceId===selectedSpeakerId?'selected':''}>${d.label||'Lautsprecher '+d.deviceId.slice(0,6)}</option>`).join('')
      : '<option value="">Standard-Ausgabe</option>';

    document.getElementById('mic-volume').value = micGain;
    document.getElementById('mic-vol-label').textContent = micGain;
    document.getElementById('mic-volume').addEventListener('input', e => {
      micGain = e.target.value;
      document.getElementById('mic-vol-label').textContent = micGain;
    });
  } catch { toast('Mikrofon-Zugriff verweigert', 'error'); }
}

async function startMicTest() {
  try {
    const micId = document.getElementById('audio-mic-select').value;
    micTestStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined } });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(micTestStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const fill = document.getElementById('audio-test-fill');
    document.getElementById('audio-test-btn').style.display = 'none';
    document.getElementById('audio-stop-btn').style.display = '';
    function draw() {
      micTestAnim = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a,b)=>a+b,0)/data.length;
      fill.style.width = Math.min(100, avg * 2) + '%';
    }
    draw();
  } catch { toast('Mikrofon nicht verfügbar', 'error'); }
}

function stopMicTest() {
  cancelAnimationFrame(micTestAnim);
  micTestStream?.getTracks().forEach(t => t.stop());
  micTestStream = null;
  document.getElementById('audio-test-fill').style.width = '0%';
  document.getElementById('audio-test-btn').style.display = '';
  document.getElementById('audio-stop-btn').style.display = 'none';
}

function saveAudioSettings() {
  selectedMicId = document.getElementById('audio-mic-select').value;
  selectedSpeakerId = document.getElementById('audio-speaker-select').value;
  localStorage.setItem('tc-mic-id', selectedMicId);
  localStorage.setItem('tc-speaker-id', selectedSpeakerId);
  localStorage.setItem('tc-mic-volume', micGain);
  stopMicTest();
  toast('Audio-Einstellungen gespeichert!', 'success');
}

// ── Edit / Delete messages ────────────────────────────────────────────
async function editMessage(id, channelId) {
  const contentEl = document.querySelector(`[data-msg-id="${id}"] .msg-content`);
  if (!contentEl) return;
  const old = contentEl.textContent;
  contentEl.innerHTML = `
    <textarea class="msg-edit-input" id="edit-${id}">${esc(old)}</textarea>
    <div class="msg-edit-actions">
      <span onclick="submitEdit(${id},${channelId})" style="color:var(--purple)">✓ Speichern</span>
      &nbsp;·&nbsp;
      <span onclick="cancelEdit(${id},'${esc(old)}')">✕ Abbrechen</span>
      <span style="margin-left:8px;font-size:11px">Enter=Senden, Esc=Abbrechen</span>
    </div>`;
  const ta = document.getElementById(`edit-${id}`);
  ta.focus(); ta.selectionStart = ta.value.length;
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(id, channelId); }
    if (e.key === 'Escape') cancelEdit(id, old);
  });
}

async function submitEdit(id, channelId) {
  const ta = document.getElementById(`edit-${id}`);
  const content = ta?.value.trim();
  if (!content) return;
  try {
    await api('PATCH', `/api/messages/${id}`, { content });
  } catch(e) { toast(e.message, 'error'); }
}

function cancelEdit(id, old) {
  const contentEl = document.querySelector(`[data-msg-id="${id}"] .msg-content`);
  if (contentEl) contentEl.innerHTML = esc(old);
}

async function deleteMessage(id, channelId) {
  if (!confirm('Nachricht löschen?')) return;
  try { await api('DELETE', `/api/messages/${id}`); }
  catch(e) { toast(e.message, 'error'); }
}

// ── Emoji reactions ───────────────────────────────────────────────────
const QUICK_EMOJIS = ['👍','❤️','😂','😮','😢','🔥','🎉','👏','💯','😎','🤔','😡'];
let emojiPickerTarget = null;

function toggleEmojiPicker(msgId, channelId, btn) {
  const existing = document.getElementById('emoji-picker-popup');
  if (existing) { existing.remove(); if (emojiPickerTarget === msgId) { emojiPickerTarget=null; return; } }
  emojiPickerTarget = msgId;
  const picker = document.createElement('div');
  picker.className = 'emoji-picker'; picker.id = 'emoji-picker-popup';
  picker.innerHTML = QUICK_EMOJIS.map(e => `<button class="emoji-btn" onclick="reactMessage(${msgId},${channelId},'${e}');document.getElementById('emoji-picker-popup')?.remove()">${e}</button>`).join('');
  const rect = btn.getBoundingClientRect();
  picker.style.cssText = `position:fixed;bottom:${window.innerHeight-rect.top+4}px;left:${rect.left}px`;
  document.body.appendChild(picker);
  setTimeout(() => document.addEventListener('click', function h(e){ if(!picker.contains(e.target)){picker.remove();document.removeEventListener('click',h);} }), 100);
}

async function reactMessage(msgId, channelId, emoji) {
  try { await api('POST', `/api/messages/${msgId}/react`, { emoji }); }
  catch(e) { toast(e.message, 'error'); }
}

function renderReactions(reactions, msgId, channelId) {
  if (!reactions || !Object.keys(reactions).length) return '';
  return '<div class="msg-reactions">' +
    Object.entries(reactions).map(([emoji, userIds]) => {
      const mine = userIds.includes(me.id);
      return `<span class="reaction${mine?' mine':''}" onclick="reactMessage(${msgId},${channelId},'${emoji}')">${emoji} <span class="reaction-count">${userIds.length}</span></span>`;
    }).join('') +
  '</div>';
}

// ── Profile popup ─────────────────────────────────────────────────────
function showProfile(userId, username, avatarColor, bio, createdAt, anchorEl) {
  document.getElementById('profile-popup-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'profile-popup-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:490';
  overlay.onclick = () => overlay.remove();
  const date = new Date((createdAt||0)*1000).toLocaleDateString('de-DE',{month:'long',year:'numeric'});
  const rect = anchorEl.getBoundingClientRect();
  const left = Math.min(rect.right+8, window.innerWidth-260);
  const top  = Math.max(8, Math.min(rect.top, window.innerHeight-240));
  overlay.innerHTML = `
    <div class="profile-popup" style="position:fixed;left:${left}px;top:${top}px" onclick="event.stopPropagation()">
      <div class="profile-banner"></div>
      <div class="profile-body">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar-big" style="background:${avatarColor}">${username[0].toUpperCase()}</div>
        </div>
        <div class="profile-name">${esc(username)}</div>
        ${bio ? `<div class="profile-bio">${esc(bio)}</div>` : ''}
        <div class="profile-joined">Dabei seit ${date}</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

// ── Settings Modal ────────────────────────────────────────────────────
function openSettings() {
  selectedColor = me.avatar_color || COLORS[0];
  document.getElementById('set-username').value = me.username;
  document.getElementById('set-bio').value = me.bio || '';
  document.getElementById('settings-name-disp').textContent = me.username;
  document.getElementById('settings-email-disp').textContent = me.email || '';
  document.getElementById('settings-avatar').textContent = me.username[0].toUpperCase();
  document.getElementById('settings-avatar').style.background = me.avatar_color;
  document.getElementById('set-err').style.display = 'none';
  document.getElementById('set-suc').style.display = 'none';

  const picker = document.getElementById('color-picker');
  picker.innerHTML = COLORS.map(c => `
    <div class="color-swatch${c===selectedColor?' selected':''}" style="background:${c}" onclick="selectColor('${c}')"></div>`).join('');

  document.getElementById('modal-settings').style.display = 'flex';
}

function selectColor(c) {
  selectedColor = c;
  document.getElementById('settings-avatar').style.background = c;
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.style.background===c||s.style.background===`${c} none repeat scroll 0% 0%`));
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.getAttribute('onclick')===`selectColor('${c}')`));
}

async function saveSettings() {
  const username    = document.getElementById('set-username').value.trim();
  const bio         = document.getElementById('set-bio').value.trim();
  const avatar_color = selectedColor;
  try {
    const r = await api('PUT', '/api/me', { username, bio, avatar_color });
    me.username = r.username; me.bio = bio; me.avatar_color = avatar_color;
    localStorage.setItem('tc-user', JSON.stringify(me));
    updateMyPanel();
    document.getElementById('set-suc').textContent = 'Gespeichert!';
    document.getElementById('set-suc').style.display = 'block';
    document.getElementById('set-err').style.display = 'none';
    toast('Profil gespeichert!', 'success');
  } catch(e) {
    document.getElementById('set-err').textContent = e.message;
    document.getElementById('set-err').style.display = 'block';
    document.getElementById('set-suc').style.display = 'none';
  }
}

async function changePassword() {
  const current     = document.getElementById('set-pw-cur').value;
  const newPassword = document.getElementById('set-pw-new').value;
  try {
    await api('PUT', '/api/me/password', { current, newPassword });
    document.getElementById('set-pw-suc').textContent = 'Passwort geändert!';
    document.getElementById('set-pw-suc').style.display = 'block';
    document.getElementById('set-pw-err').style.display = 'none';
    document.getElementById('set-pw-cur').value = '';
    document.getElementById('set-pw-new').value = '';
    toast('Passwort geändert!', 'success');
  } catch(e) {
    document.getElementById('set-pw-err').textContent = e.message;
    document.getElementById('set-pw-err').style.display = 'block';
    document.getElementById('set-pw-suc').style.display = 'none';
  }
}

function logout() {
  localStorage.removeItem('tc-token');
  localStorage.removeItem('tc-user');
  location.href = '/';
}

// ── Modals ────────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function closeModalOutside(e, id) { if (e.target.id === id) closeModal(id); }

// ── UI helpers ────────────────────────────────────────────────────────
function setActiveItem(id) {
  document.querySelectorAll('.channel-item, .dm-item').forEach(el => el.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function showHeader(icon, name, desc) {
  document.getElementById('chat-header').style.display = 'flex';
  document.getElementById('chat-header-icon').textContent = icon;
  document.getElementById('chat-header-name').textContent = name;
  document.getElementById('chat-header-desc').textContent = desc;
  document.getElementById('welcome').style.display = 'none';
}

function showChatUI() {
  document.getElementById('messages-area').style.display = 'flex';
  document.getElementById('messages-area').innerHTML = '';
  document.getElementById('input-area').style.display = '';
  document.getElementById('typing-indicator').style.display = '';
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Boot ──────────────────────────────────────────────────────────────
init();
