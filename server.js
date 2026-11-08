/**
 * CS2 Web Strike — Dedicated Multiplayer WebSocket Server (Node.js)
 * Поддерживает:
 *  - Автоматический поиск матча (Quick Match)
 *  - Приватные комнаты по 4-значному коду
 *  - Полную синхронизацию игроков через центральный сервер (без P2P / NAT проблем)
 *  - Раздачу index.html и /healthz для бесплатного хостинга Render.com / Koyeb
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;

// HTTP-сервер: раздает index.html и отвечает на проверки /healthz от Render / Koyeb
const server = http.createServer((req, res) => {
    // Разрешаем CORS для подключения с GitHub Pages
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.url === '/healthz' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, uptime: process.uptime() }));
        return;
    }

    if (req.url === '/' || req.url.startsWith('/index.html')) {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('CS2 Dedicated WebSocket Server is running! Connect via WebSocket.');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
});

const wss = new WebSocketServer({ server });

// Хранилище комнат: code -> { code, isPublic, players: [ws1, ws2] }
const rooms = new Map();

function generateRoomCode() {
    let code = '1000';
    do {
        code = String(Math.floor(1000 + Math.random() * 9000));
    } while (rooms.has(code));
    return code;
}

function sendJSON(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function removePlayerFromRoom(ws) {
    const code = ws.roomCode;
    if (!code || !rooms.has(code)) return;

    const room = rooms.get(code);
    room.players = room.players.filter(p => p !== ws);
    ws.roomCode = null;

    if (room.players.length === 0) {
        rooms.delete(code);
    } else {
        // Уведомляем оставшегося игрока, что соперник вышел, и делаем его хостом комнаты
        const remaining = room.players[0];
        remaining.isHost = true;
        sendJSON(remaining, { type: 'opponent_left', code });
    }
}

function pairRoomPlayers(room) {
    if (room.players.length < 2) return;
    const [p1, p2] = room.players;
    p1.isHost = true;
    p2.isHost = false;

    sendJSON(p1, {
        type: 'match_ready',
        code: room.code,
        isHost: true,
        opponentName: p2.playerName || 'Игрок_2'
    });

    sendJSON(p2, {
        type: 'match_ready',
        code: room.code,
        isHost: false,
        opponentName: p1.playerName || 'Игрок_1'
    });
}

wss.on('connection', (ws) => {
    ws.playerName = 'Спецназ';
    ws.roomCode = null;
    ws.isHost = false;
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (raw) => {
        let pkt;
        try {
            pkt = JSON.parse(raw);
        } catch (e) {
            return;
        }
        if (!pkt || !pkt.type) return;

        // 1. Пинг-ответ от самого сервера (когда второй игрок еще не подключен)
        if (pkt.type === 'ping') {
            const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
            if (!room || room.players.length < 2) {
                sendJSON(ws, { type: 'pong', t: pkt.t, manual: pkt.manual });
                return;
            }
        }

        // 2. Создание приватной комнаты по 4-значному коду
        if (pkt.type === 'create_room') {
            removePlayerFromRoom(ws);
            ws.playerName = (pkt.name || 'Спецназ_01').slice(0, 16);
            const code = generateRoomCode();
            const room = { code, isPublic: false, players: [ws] };
            rooms.set(code, room);
            ws.roomCode = code;
            ws.isHost = true;

            sendJSON(ws, { type: 'room_created', code });
            return;
        }

        // 3. Вход в комнату по 4-значному коду
        if (pkt.type === 'join_room') {
            removePlayerFromRoom(ws);
            ws.playerName = (pkt.name || 'Спецназ_02').slice(0, 16);
            const code = String(pkt.code || '').trim();
            const room = rooms.get(code);

            if (!room) {
                sendJSON(ws, { type: 'error_msg', message: `Комната #${code} не найдена на сервере!` });
                return;
            }
            if (room.players.length >= 2) {
                sendJSON(ws, { type: 'error_msg', message: `Комната #${code} уже заполнена (2/2)!` });
                return;
            }

            room.players.push(ws);
            ws.roomCode = code;
            ws.isHost = false;

            sendJSON(ws, { type: 'room_joined', code, isHost: false });
            pairRoomPlayers(room);
            return;
        }

        // 4. Быстрый поиск игры (Quick Match) — ищет свободную публичную комнату или создает новую
        if (pkt.type === 'quick_match') {
            removePlayerFromRoom(ws);
            ws.playerName = (pkt.name || 'Спецназ').slice(0, 16);

            let targetRoom = null;
            for (const r of rooms.values()) {
                if (r.isPublic && r.players.length === 1) {
                    targetRoom = r;
                    break;
                }
            }

            if (targetRoom) {
                targetRoom.players.push(ws);
                ws.roomCode = targetRoom.code;
                ws.isHost = false;
                sendJSON(ws, { type: 'room_joined', code: targetRoom.code, isHost: false });
                pairRoomPlayers(targetRoom);
            } else {
                const code = generateRoomCode();
                const newRoom = { code, isPublic: true, players: [ws] };
                rooms.set(code, newRoom);
                ws.roomCode = code;
                ws.isHost = true;
                sendJSON(ws, { type: 'room_created', code });
            }
            return;
        }

        // 5. Ретрансляция игровых пакетов (state, shoot, hit, respawn, hello, ping, pong) сопернику в комнате
        if (ws.roomCode && rooms.has(ws.roomCode)) {
            const room = rooms.get(ws.roomCode);
            for (const client of room.players) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(raw.toString());
                }
            }
        }
    });

    ws.on('close', () => {
        removePlayerFromRoom(ws);
    });

    ws.on('error', () => {
        removePlayerFromRoom(ws);
    });
});

// Проверка зависших соединений каждые 30 секунд
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            removePlayerFromRoom(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(heartbeatInterval);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[CS2 Dedicated Server] Сервер запущен на порту ${PORT}`);
});
