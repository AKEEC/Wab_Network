// public/js/app.js
(() => {
    const ICE_CONFIG = {
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        }
    };

    // ---------- DOM refs ----------
    const loginScreen = document.getElementById('login-screen');
    const usernameInput = document.getElementById('username-input');
    const joinBtn = document.getElementById('join-btn');

    const appEl = document.getElementById('app');
    const sidebarEl = document.getElementById('sidebar');
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');
    const menuToggle = document.getElementById('menu-toggle');

    const roomListEl = document.getElementById('room-list');
    const userListEl = document.getElementById('user-list');
    const addRoomBtn = document.getElementById('add-room-btn');

    const meAvatar = document.getElementById('me-avatar');
    const meName = document.getElementById('me-name');

    const currentTitle = document.getElementById('current-title');
    const voiceToggleBtn = document.getElementById('voice-toggle-btn');

    const videoPanel = document.getElementById('video-panel');
    const messagesEl = document.getElementById('messages');
    const msgInput = document.getElementById('msg-input');
    const sendBtn = document.getElementById('send-btn');

    const callModal = document.getElementById('call-modal');
    const callAvatar = document.getElementById('call-avatar');
    const callTitle = document.getElementById('call-title');
    const callSub = document.getElementById('call-sub');
    const acceptCallBtn = document.getElementById('accept-call-btn');
    const rejectCallBtn = document.getElementById('reject-call-btn');

    // ---------- State ----------
    let socket = null;
    let myUsername = null;
    let currentRoom = 'general';
    // view: {type:'room', name} | {type:'dm', name}
    let currentView = { type: 'room', name: 'general' };
    let dmCache = {}; // username -> messages[]
    let unreadDm = new Set();

    let peer = null;
    let peerReady = null; // promise

    let mode = 'idle'; // idle | group-voice | direct-call
    let groupVoicePeers = {}; // peerId -> {call, username}
    let directCall = null; // {call, otherUsername, incomingFromPeerId}
    let localStream = null;
    let pendingIncoming = null; // {fromUsername, fromPeerId}

    // ---------- Helpers ----------
    function initials(name) {
        return (name || '?').trim().slice(0, 2).toUpperCase();
    }

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.innerText = str;
        return d.innerHTML;
    }

    function fmtTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    }

    function toast(text) {
        const el = document.createElement('div');
        el.className = 'toast';
        el.innerText = text;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    function closeSidebarMobile() {
        sidebarEl.classList.remove('open');
        sidebarBackdrop.classList.remove('open');
    }

    // ---------- Login ----------
    function doJoin() {
        const name = usernameInput.value.trim();
        if (!name) { usernameInput.focus(); return; }

        socket = io();
        wireSocketEvents();
        socket.emit('join', name);
    }

    joinBtn.addEventListener('click', doJoin);
    usernameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') doJoin(); });

    // ---------- Socket events ----------
    function wireSocketEvents() {
        socket.on('joined', ({ username, rooms, room }) => {
            myUsername = username;
            currentRoom = room;
            currentView = { type: 'room', name: room };

            meName.innerText = myUsername;
            meAvatar.innerText = initials(myUsername);

            loginScreen.style.display = 'none';
            appEl.classList.add('active');

            renderRoomList(rooms);
            setActiveTitle();
        });

        socket.on('room-list', (rooms) => renderRoomList(rooms));

        socket.on('room-history', ({ room, messages }) => {
            if (currentView.type === 'room' && currentView.name === room) {
                renderMessages(messages.map(m => ({ kind: 'chat', ...m })));
            }
        });

        socket.on('voice-members', () => { /* informational only */ });

        socket.on('chat-message', (m) => {
            if (currentView.type === 'room' && currentView.name === m.room) {
                appendMessage({ kind: 'chat', ...m });
            } else {
                toast(`ข้อความใหม่ใน #${m.room} จาก ${m.user}`);
            }
        });

        socket.on('system-message', (m) => {
            if (currentView.type === 'room' && currentView.name === m.room) {
                appendMessage({ kind: 'system', ...m });
            }
        });

        socket.on('user-list', (users) => renderUserList(users));

        socket.on('dm-message', (m) => {
            const other = m.from === myUsername ? m.to : m.from;
            if (!dmCache[other]) dmCache[other] = [];
            dmCache[other].push(m);

            if (currentView.type === 'dm' && currentView.name === other) {
                appendMessage({ kind: 'dm', ...m });
            } else if (m.from !== myUsername) {
                unreadDm.add(other);
                toast(`ข้อความส่วนตัวจาก ${m.from}`);
                renderUserList(lastUserListCache);
            }
        });

        socket.on('dm-history', ({ withUser, messages }) => {
            dmCache[withUser] = messages;
            if (currentView.type === 'dm' && currentView.name === withUser) {
                renderMessages(messages.map(m => ({ kind: 'dm', ...m })));
            }
        });

        // ---------- Group voice signaling ----------
        socket.on('voice-existing-members', ({ members }) => {
            // ตัดปัญหา race ตอนหลายคนกดเข้าพร้อมกัน: ใช้ peerId เป็นตัวตัดสิน
            // ว่าใครเป็นฝ่ายโทรหาใครเพียงฝั่งเดียว ลดสายซ้ำ/รับสายไม่ทัน
            if (mode !== 'group-voice' || !peer?.id) return;
            members.forEach(m => {
                if (!m.peerId || m.peerId === peer.id) return;
                if (peer.id < m.peerId) callGroupPeer(m.peerId, m.username);
            });
        });

        socket.on('voice-user-joined', ({ peerId, username }) => {
            if (mode === 'group-voice' && peer?.id && peer.id < peerId) {
                callGroupPeer(peerId, username);
            }
            toast(`${username} เข้าร่วมช่องเสียง`);
        });

        socket.on('voice-user-left', ({ peerId, username }) => {
            toast(`${username} ออกจากช่องเสียง`);
            removeGroupPeerTile(peerId);
        });

        // ---------- Direct 1-1 call signaling ----------
        socket.on('incoming-direct-call', ({ fromUsername, fromPeerId }) => {
            if (mode !== 'idle' || pendingIncoming) {
                socket.emit('direct-call-response', { toUsername: fromUsername, accepted: false });
                return;
            }
            pendingIncoming = { fromUsername, fromPeerId };
            showIncomingCallModal(fromUsername);
        });

        socket.on('direct-call-response', ({ fromUsername, accepted, peerId }) => {
            if (!directCall || directCall.otherUsername !== fromUsername) return;

            if (!accepted) {
                toast(`${fromUsername} ปฏิเสธสาย`);
                endDirectCall(false);
                return;
            }

            // ผู้โทรเป็นฝ่ายสร้าง WebRTC call หลังอีกฝ่ายตอบรับแล้ว
            if (!peer || peer.destroyed || !localStream || !peerId) {
                toast('สร้างการเชื่อมต่อวิดีโอไม่สำเร็จ');
                endDirectCall(true);
                return;
            }

            directCall.expectedPeerId = peerId;
            const call = peer.call(peerId, localStream);
            directCall.call = call;
            wireDirectCall(call, fromUsername);
            voiceToggleBtn_setCallUi(fromUsername);
        });

        socket.on('direct-call-failed', ({ targetUsername }) => {
            toast(`${targetUsername} ไม่ได้ออนไลน์อยู่`);
            endDirectCall(false);
        });

        socket.on('direct-call-end', () => {
            const other = directCall ? directCall.otherUsername : 'อีกฝ่าย';
            toast(`${other} วางสายแล้ว`);
            endDirectCall(false);
        });

        socket.on('disconnect', () => {
            if (callModal.classList.contains('active')) {
                callModal.classList.remove('active');
                pendingIncoming = null;
            }
            if (mode === 'direct-call') endDirectCall(false);
            toast('การเชื่อมต่อหลุด กำลังลองเชื่อมต่อใหม่...');
        });
    }

    let lastUserListCache = [];

    // ---------- Rendering: rooms / users ----------
    function renderRoomList(rooms) {
        roomListEl.innerHTML = '';
        rooms.forEach(r => {
            const div = document.createElement('div');
            div.className = 'room-item' + (currentView.type === 'room' && currentView.name === r ? ' active' : '');
            div.innerHTML = `<span class="icon">#</span><span>${escapeHtml(r)}</span>`;
            div.addEventListener('click', () => switchToRoom(r));
            roomListEl.appendChild(div);
        });
    }

    function renderUserList(users) {
        lastUserListCache = users;
        userListEl.innerHTML = '';
        users
            .filter(u => u.username !== myUsername)
            .forEach(u => {
                const div = document.createElement('div');
                div.className = 'user-item';

                const left = document.createElement('div');
                left.className = 'user-left';
                left.innerHTML = `<span class="dot"></span><span class="uname">${escapeHtml(u.username)}${u.inVoice ? ' 🎙️' : ''}</span>` +
                    (unreadDm.has(u.username) ? ' <span style="color:#faa61a;">●</span>' : '');
                left.addEventListener('click', () => openDm(u.username));

                const callBtn = document.createElement('button');
                callBtn.className = 'call-btn';
                callBtn.title = `โทรหา ${u.username}`;
                callBtn.innerText = '📞';
                callBtn.addEventListener('click', (e) => { e.stopPropagation(); startDirectCall(u.username); });

                div.appendChild(left);
                div.appendChild(callBtn);
                userListEl.appendChild(div);
            });
    }

    function setActiveTitle() {
        if (currentView.type === 'room') {
            currentTitle.innerText = '# ' + currentView.name;
            voiceToggleBtn.style.display = 'inline-flex';
        } else {
            currentTitle.innerText = '@ ' + currentView.name;
            voiceToggleBtn.style.display = 'none';
        }
    }

    // ---------- Switching views ----------
    function switchToRoom(room) {
        if (mode === 'group-voice' && currentRoom !== room) {
            leaveGroupVoice();
        }
        currentRoom = room;
        currentView = { type: 'room', name: room };
        socket.emit('switch-room', room);
        renderRoomList(getKnownRooms());
        setActiveTitle();
        messagesEl.innerHTML = '';
        closeSidebarMobile();
        updateVoiceToggleUi();
    }

    function getKnownRooms() {
        return Array.from(roomListEl.querySelectorAll('.room-item span:nth-child(2)')).map(s => s.innerText);
    }

    function openDm(username) {
        currentView = { type: 'dm', name: username };
        unreadDm.delete(username);
        renderRoomList(getKnownRooms());
        setActiveTitle();
        messagesEl.innerHTML = '';
        if (dmCache[username]) {
            renderMessages(dmCache[username].map(m => ({ kind: 'dm', ...m })));
        } else {
            socket.emit('request-dm-history', username);
        }
        closeSidebarMobile();
        renderUserList(lastUserListCache);
    }

    addRoomBtn.addEventListener('click', () => {
        const name = prompt('ตั้งชื่อห้องใหม่ (กลุ่ม):');
        if (name && name.trim()) {
            socket.emit('create-room', name.trim());
        }
    });

    // ---------- Messages ----------
    function renderMessages(list) {
        messagesEl.innerHTML = '';
        list.forEach(appendMessage);
    }

    function appendMessage(m) {
        if (m.kind === 'system') {
            const el = document.createElement('div');
            el.className = 'system-msg';
            el.innerText = m.text;
            messagesEl.appendChild(el);
        } else {
            const who = m.kind === 'dm' ? m.from : m.user;
            const row = document.createElement('div');
            row.className = 'msg-row';
            row.innerHTML = `
                <div class="msg-avatar">${initials(who)}</div>
                <div class="msg-body">
                    <div class="msg-head">
                        <span class="msg-user">${escapeHtml(who)}</span>
                        <span class="msg-time">${fmtTime(m.time)}</span>
                    </div>
                    <div class="msg-text"></div>
                </div>`;
            row.querySelector('.msg-text').innerText = m.text;
            messagesEl.appendChild(row);
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function sendCurrentMessage() {
        const text = msgInput.value.trim();
        if (!text) return;
        if (currentView.type === 'room') {
            socket.emit('chat-message', { room: currentView.name, text });
        } else {
            socket.emit('dm-message', { to: currentView.name, text });
        }
        msgInput.value = '';
    }

    sendBtn.addEventListener('click', sendCurrentMessage);
    msgInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendCurrentMessage(); });

    // ---------- Sidebar toggle (mobile) ----------
    menuToggle.addEventListener('click', () => {
        sidebarEl.classList.add('open');
        sidebarBackdrop.classList.add('open');
    });
    sidebarBackdrop.addEventListener('click', closeSidebarMobile);

    // ---------- Peer / media helpers ----------
    function ensurePeer() {
        if (peer && !peer.destroyed && peerReady) return peerReady;

        peer = new Peer(ICE_CONFIG);
        peerReady = new Promise((resolve, reject) => {
            const onOpen = () => {
                peer.off('error', onPeerOpenError);
                resolve(peer.id);
            };
            const onPeerOpenError = (err) => reject(err);
            peer.once('open', onOpen);
            peer.once('error', onPeerOpenError);
        });

        // มี handler เดียวสำหรับสาย WebRTC ทุกประเภท
        peer.on('call', (call) => {
            if (!call) return;

            if (mode === 'group-voice' && localStream) {
                const username = groupVoicePeers[call.peer]?.username || 'สมาชิก';
                groupVoicePeers[call.peer] = { call, username };
                call.answer(localStream);
                call.on('stream', (remoteStream) => {
                    addVideoTile('group-' + call.peer, username, remoteStream, false);
                });
                call.on('close', () => removeGroupPeerTile(call.peer, false));
                call.on('error', () => removeGroupPeerTile(call.peer, false));
                return;
            }

            if (mode === 'direct-call' && directCall) {
                // รับเฉพาะสายจากคนที่เราตกลงรับสายไว้ ป้องกันสายเก่าหรือสายซ้ำ
                if (directCall.expectedPeerId && call.peer !== directCall.expectedPeerId) {
                    try { call.close(); } catch (_) {}
                    return;
                }
                directCall.expectedPeerId = call.peer;
                directCall.call = call;
                call.answer(localStream);
                wireDirectCall(call, directCall.otherUsername);
            } else {
                try { call.close(); } catch (_) {}
            }
        });

        peer.on('error', (err) => {
            console.warn('PeerJS error:', err);
            if (mode === 'direct-call') toast('การเชื่อมต่อสายล้มเหลว');
        });

        return peerReady;
    }

    function wireDirectCall(call, username) {
        call.on('stream', (remoteStream) => {
            addVideoTile('direct-' + username, username, remoteStream, false);
        });
        call.on('close', () => {
            if (mode === 'direct-call') endDirectCall(false);
        });
        call.on('error', (err) => {
            console.warn('Direct call error:', err);
            if (mode === 'direct-call') {
                toast('เชื่อมต่อวิดีโอไม่สำเร็จ');
                endDirectCall(true);
            }
        });
    }

    async function getLocalMedia() {
        if (localStream && localStream.active) return localStream;
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        return localStream;
    }

    function addVideoTile(id, label, stream, isSelf) {
        removeVideoTileById(id);
        const tile = document.createElement('div');
        tile.className = 'video-tile' + (isSelf ? ' self' : '');
        tile.dataset.tileId = id;
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = !!isSelf;
        video.srcObject = stream;
        const labelEl = document.createElement('div');
        labelEl.className = 'tile-label';
        labelEl.innerText = label;
        tile.appendChild(video);
        tile.appendChild(labelEl);
        videoPanel.appendChild(tile);
        videoPanel.classList.add('active');
        // บาง browser ต้องสั่ง play() หลัง srcObject ถูกกำหนด
        video.play().catch(() => {});
    }

    function removeVideoTileById(id) {
        const el = videoPanel.querySelector(`[data-tile-id="${CSS.escape(id)}"]`);
        if (el) {
            const video = el.querySelector('video');
            if (video) video.srcObject = null;
            el.remove();
        }
        if (!videoPanel.children.length) videoPanel.classList.remove('active');
    }

    function clearAllVideoTiles() {
        videoPanel.querySelectorAll('video').forEach(v => { v.srcObject = null; });
        videoPanel.innerHTML = '';
        videoPanel.classList.remove('active');
    }

    // ---------- Group voice call (per room) ----------
    function callGroupPeer(peerId, username) {
        if (!localStream || !peer || peer.destroyed || !peerId || peerId === peer.id) return;
        if (groupVoicePeers[peerId]?.call) return;

        const call = peer.call(peerId, localStream);
        groupVoicePeers[peerId] = { call, username };
        call.on('stream', (remoteStream) => {
            addVideoTile('group-' + peerId, username, remoteStream, false);
        });
        call.on('close', () => removeGroupPeerTile(peerId, false));
        call.on('error', () => removeGroupPeerTile(peerId, false));
    }

    function removeGroupPeerTile(peerId, closeCall = true) {
        const entry = groupVoicePeers[peerId];
        if (entry && closeCall && entry.call) {
            try { entry.call.close(); } catch (e) {}
        }
        delete groupVoicePeers[peerId];
        removeVideoTileById('group-' + peerId);
    }

    async function joinGroupVoice() {
        if (mode !== 'idle') { toast('กำลังใช้งานสายอื่นอยู่'); return; }
        try {
            await getLocalMedia();
            await ensurePeer();
        } catch (err) {
            console.warn(err);
            toast('ไม่สามารถเข้าถึงกล้อง/ไมค์ได้');
            stopLocalStream();
            return;
        }

        mode = 'group-voice';
        addVideoTile('self', 'คุณ', localStream, true);
        const myId = await peerReady;
        socket.emit('voice-join', { room: currentRoom, peerId: myId });
        updateVoiceToggleUi();
    }

    function leaveGroupVoice() {
        socket.emit('voice-leave');
        Object.keys(groupVoicePeers).forEach(id => removeGroupPeerTile(id));
        groupVoicePeers = {};
        stopLocalStream();
        clearAllVideoTiles();
        mode = 'idle';
        updateVoiceToggleUi();
    }

    voiceToggleBtn.addEventListener('click', () => {
        if (mode === 'group-voice') leaveGroupVoice();
        else joinGroupVoice();
    });

    function updateVoiceToggleUi() {
        const label = voiceToggleBtn.querySelector('.label');
        if (mode === 'group-voice') {
            voiceToggleBtn.classList.add('leave');
            if (label) label.innerText = 'ออกจากช่องเสียง';
            voiceToggleBtn.firstChild.textContent = '🔴';
        } else {
            voiceToggleBtn.classList.remove('leave');
            if (label) label.innerText = 'เข้าร่วมช่องเสียง';
            voiceToggleBtn.firstChild.textContent = '🎤';
        }
    }

    // ---------- Direct 1-1 call ----------
    async function startDirectCall(username) {
        if (mode !== 'idle') { toast('กำลังใช้งานสายอื่นอยู่'); return; }

        try {
            await getLocalMedia();
            await ensurePeer();
        } catch (err) {
            console.warn(err);
            toast('ไม่สามารถเข้าถึงกล้อง/ไมค์ได้');
            stopLocalStream();
            return;
        }

        mode = 'direct-call';
        directCall = { otherUsername: username, call: null, expectedPeerId: null };
        addVideoTile('self', 'คุณ', localStream, true);

        const myId = await peerReady;
        socket.emit('direct-call-request', { targetUsername: username, peerId: myId });
        toast(`กำลังโทรหา ${username}...`);
        voiceToggleBtn_setCallUi(username);
    }

    function showIncomingCallModal(fromUsername) {
        callAvatar.innerText = initials(fromUsername);
        callTitle.innerText = `${fromUsername} กำลังโทรหาคุณ`;
        callSub.innerText = 'วิดีโอคอลเดี่ยว';
        callModal.classList.add('active');
    }

    acceptCallBtn.addEventListener('click', async () => {
        if (!pendingIncoming) return;

        const incoming = pendingIncoming;
        pendingIncoming = null;
        callModal.classList.remove('active');

        try {
            await getLocalMedia();
            await ensurePeer();
        } catch (err) {
            console.warn(err);
            toast('ไม่สามารถเข้าถึงกล้อง/ไมค์ได้');
            socket.emit('direct-call-response', { toUsername: incoming.fromUsername, accepted: false });
            stopLocalStream();
            return;
        }

        mode = 'direct-call';
        directCall = {
            otherUsername: incoming.fromUsername,
            call: null,
            expectedPeerId: incoming.fromPeerId
        };
        addVideoTile('self', 'คุณ', localStream, true);

        const myId = await peerReady;
        socket.emit('direct-call-response', {
            toUsername: incoming.fromUsername,
            accepted: true,
            peerId: myId
        });
        voiceToggleBtn_setCallUi(incoming.fromUsername);
    });

    rejectCallBtn.addEventListener('click', () => {
        if (!pendingIncoming) return;
        const username = pendingIncoming.fromUsername;
        socket.emit('direct-call-response', { toUsername: username, accepted: false });
        callModal.classList.remove('active');
        pendingIncoming = null;
    });

    function endDirectCall(notifyOther) {
        const call = directCall?.call;
        const other = directCall?.otherUsername;
        if (notifyOther && other) {
            socket.emit('direct-call-end', { toUsername: other });
        }
        if (call) {
            try { call.close(); } catch (e) {}
        }
        directCall = null;
        pendingIncoming = null;
        if (callModal) callModal.classList.remove('active');
        stopLocalStream();
        clearAllVideoTiles();
        mode = 'idle';
        hideCallUiBar();
    }

    function stopLocalStream() {
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
    }

    // แถบแสดงสถานะ "กำลังคุยกับ..." พร้อมปุ่มวางสาย ต่อท้าย topbar
    let callBar = null;
    function voiceToggleBtn_setCallUi(otherUsername) {
        if (callBar) callBar.remove();
        callBar = document.createElement('button');
        callBar.className = 'topbar-btn leave';
        callBar.innerHTML = `📞<span class="label">วางสาย (${escapeHtml(otherUsername)})</span>`;
        callBar.addEventListener('click', () => endDirectCall(true));
        document.getElementById('topbar-actions').appendChild(callBar);
    }
    function hideCallUiBar() {
        if (callBar) { callBar.remove(); callBar = null; }
    }
})();
