// server.js - Mini Discord backend
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory state ----------
// socketId -> { username, room, peerId, inVoice }
const onlineUsers = {};
// roomName -> { messages: [{user, text, time}], voice: { socketId: {username, peerId} } }
const rooms = {
    general: { messages: [], voice: {} }
};
// dmKey ("userA|userB" sorted) -> [{from, text, time}]
const dmHistory = {};

function dmKey(a, b) {
    return [a, b].sort().join('|');
}

function getUserList() {
    return Object.values(onlineUsers).map(u => ({
        username: u.username,
        room: u.room,
        inVoice: u.inVoice
    }));
}

function getRoomList() {
    return Object.keys(rooms);
}

function broadcastUserList() {
    io.emit('user-list', getUserList());
}

function findSocketByUsername(username) {
    return Object.keys(onlineUsers).find(id => onlineUsers[id].username === username);
}

io.on('connection', (socket) => {
    console.log('มีการเชื่อมต่อใหม่:', socket.id);

    // ---------- เข้าสู่ระบบด้วยชื่อผู้ใช้ ----------
    socket.on('join', (username) => {
        username = String(username || '').trim().slice(0, 24) || `User${socket.id.slice(0, 4)}`;

        // กันชื่อซ้ำ
        let finalName = username;
        let n = 1;
        while (Object.values(onlineUsers).some(u => u.username === finalName)) {
            finalName = `${username}${n++}`;
        }

        onlineUsers[socket.id] = { username: finalName, room: 'general', peerId: null, inVoice: false };
        socket.join('general');

        socket.emit('joined', { username: finalName, rooms: getRoomList(), room: 'general' });
        socket.emit('room-history', { room: 'general', messages: rooms.general.messages });
        socket.emit('voice-members', { room: 'general', members: rooms.general.voice });

        broadcastUserList();
        io.to('general').emit('system-message', { room: 'general', text: `${finalName} เข้าร่วมห้องแล้ว`, time: Date.now() });
    });

    // ---------- ห้องแชท/กลุ่ม ----------
    socket.on('create-room', (roomName) => {
        roomName = String(roomName || '').trim().slice(0, 24);
        if (!roomName) return;
        if (!rooms[roomName]) {
            rooms[roomName] = { messages: [], voice: {} };
            io.emit('room-list', getRoomList());
        }
    });

    socket.on('switch-room', (roomName) => {
        const user = onlineUsers[socket.id];
        if (!user || !rooms[roomName]) return;

        // ออกจากช่องเสียงห้องเก่าถ้ากำลังอยู่
        if (user.inVoice) {
            leaveVoice(socket);
        }

        socket.leave(user.room);
        user.room = roomName;
        socket.join(roomName);

        socket.emit('room-history', { room: roomName, messages: rooms[roomName].messages });
        socket.emit('voice-members', { room: roomName, members: rooms[roomName].voice });
        broadcastUserList();
    });

    socket.on('chat-message', ({ room, text }) => {
        const user = onlineUsers[socket.id];
        if (!user || !rooms[room] || !text || !String(text).trim()) return;
        const msg = { user: user.username, text: String(text).slice(0, 2000), time: Date.now() };
        rooms[room].messages.push(msg);
        if (rooms[room].messages.length > 200) rooms[room].messages.shift();
        io.to(room).emit('chat-message', { room, ...msg });
    });

    // ---------- ข้อความส่วนตัว (DM) ไม่ต้องผ่านการโทร ----------
    socket.on('dm-message', ({ to, text }) => {
        const user = onlineUsers[socket.id];
        if (!user || !to || !text || !String(text).trim()) return;
        const key = dmKey(user.username, to);
        const msg = { from: user.username, to, text: String(text).slice(0, 2000), time: Date.now() };
        if (!dmHistory[key]) dmHistory[key] = [];
        dmHistory[key].push(msg);
        if (dmHistory[key].length > 200) dmHistory[key].shift();

        socket.emit('dm-message', msg);
        const targetId = findSocketByUsername(to);
        if (targetId) io.to(targetId).emit('dm-message', msg);
    });

    socket.on('request-dm-history', (withUser) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const key = dmKey(user.username, withUser);
        socket.emit('dm-history', { withUser, messages: dmHistory[key] || [] });
    });

    // ---------- วิดีโอคอลกลุ่ม (ต่อห้อง) ----------
    function leaveVoice(sock) {
        const user = onlineUsers[sock.id];
        if (!user || !user.inVoice) return;
        const room = user.room;
        if (rooms[room]) {
            delete rooms[room].voice[sock.id];
            sock.to(room).emit('voice-user-left', { peerId: user.peerId, username: user.username });
        }
        user.inVoice = false;
    }

    socket.on('voice-join', ({ room, peerId }) => {
        const user = onlineUsers[socket.id];
        if (!user || !rooms[room] || user.room !== room || !peerId) return;

        // เก็บสมาชิกใหม่ก่อน แล้วค่อยส่งรายชื่อเดิมให้ เพื่อให้กรณีหลายคนกดพร้อมกัน
        // มีสถานะในเซิร์ฟเวอร์ที่สอดคล้องกัน
        if (user.inVoice) leaveVoice(socket);
        user.peerId = String(peerId);
        user.inVoice = true;
        rooms[room].voice[socket.id] = { username: user.username, peerId: user.peerId };

        const existing = Object.entries(rooms[room].voice)
            .filter(([socketId]) => socketId !== socket.id)
            .map(([, member]) => member);
        socket.emit('voice-existing-members', { room, members: existing });
        socket.to(room).emit('voice-user-joined', { peerId: user.peerId, username: user.username });
        broadcastUserList();
    });

    socket.on('voice-leave', () => {
        leaveVoice(socket);
        broadcastUserList();
    });

    // ---------- โทรเดี่ยว 1-1 ----------
    socket.on('direct-call-request', ({ targetUsername, peerId }) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const targetId = findSocketByUsername(targetUsername);
        if (!targetId) {
            socket.emit('direct-call-failed', { reason: 'offline', targetUsername });
            return;
        }
        io.to(targetId).emit('incoming-direct-call', { fromUsername: user.username, fromPeerId: peerId });
    });

    socket.on('direct-call-response', ({ toUsername, accepted, peerId }) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const targetId = findSocketByUsername(toUsername);
        if (!targetId) return;
        io.to(targetId).emit('direct-call-response', { fromUsername: user.username, accepted, peerId });
    });

    socket.on('direct-call-end', ({ toUsername }) => {
        const targetId = findSocketByUsername(toUsername);
        if (targetId) io.to(targetId).emit('direct-call-end');
    });

    // ---------- ตัดการเชื่อมต่อ ----------
    socket.on('disconnect', () => {
        const user = onlineUsers[socket.id];
        if (user) {
            leaveVoice(socket);
            io.to(user.room).emit('system-message', { room: user.room, text: `${user.username} ออกจากห้อง`, time: Date.now() });
            delete onlineUsers[socket.id];
            broadcastUserList();
        }
        console.log('ตัดการเชื่อมต่อ:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server รันอยู่ที่ http://localhost:${PORT}`);
});
