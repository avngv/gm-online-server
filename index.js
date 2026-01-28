const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;
const TURNS = 6;
const RECONNECT_TIMEOUT = 30000;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = []; 
let disconnectedPlayers = {}; 

let match = {
    diceRolls: [],
    guesses: [[], []],
    currentTurn: 0,
    playerIds: []
};

function sendToGM(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const msg = JSON.stringify(obj) + "\0"; 
        ws.send(msg);
    }
}

function safeJSON(data) {
    try {
        const str = data.toString().replace(/\0/g, '');
        return JSON.parse(str);
    } catch (e) { return null; }
}

function broadcast(obj) {
    players.forEach(p => sendToGM(p.ws, obj));
}

// --- LOGIC TRẬN ĐẤU GIỮ NGUYÊN ---
function rollDice() {
    const arr = [1, 2, 3, 4, 5, 6];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function startMatch() {
    match.diceRolls = rollDice();
    match.guesses = [[], []];
    match.currentTurn = 0;
    match.playerIds = players.map(p => p.playerId);
    console.log("Match started:", match.diceRolls);
    broadcast({ type: "match_start", turns: TURNS });
    nextTurn();
}

function nextTurn() {
    if (match.currentTurn >= TURNS) {
        endMatch();
        return;
    }
    broadcast({ type: "turn_start", turn: match.currentTurn + 1 });
    match.currentTurn++;
}

function endMatch() {
    const results = [0, 0];
    for (let i = 0; i < TURNS; i++) {
        for (let p = 0; p < 2; p++) {
            if (match.guesses[p][i] === match.diceRolls[i]) results[p]++;
        }
    }
    let winner = null;
    if (results[0] > results[1]) winner = 0;
    else if (results[1] > results[0]) winner = 1;

    broadcast({
        type: "match_end",
        diceRolls: match.diceRolls,
        guesses: match.guesses,
        results,
        winner
    });

    match = { diceRolls: [], guesses: [[], []], currentTurn: 0, playerIds: [] };
    players = [];
}

// --- LOGIC KẾT NỐI (ĐÃ SỬA) ---

function handleDisconnect(player) {
    console.log("Player disconnected:", player.playerId);
    players = players.filter(p => p.playerId !== player.playerId);
    broadcast({ type: "opponent_left" });

    // Lưu timeout để xóa hẳn nếu không quay lại
    disconnectedPlayers[player.playerId] = setTimeout(() => {
        console.log("Xóa hẳn player do quá thời gian:", player.playerId);
        delete disconnectedPlayers[player.playerId];
        // Nếu trận đấu đang diễn ra mà chỉ còn 1 người, có thể kết thúc sớm ở đây
    }, RECONNECT_TIMEOUT);
}

wss.on("connection", (ws) => {
    console.log("New connection");

    ws.on("message", (data) => {
        const msg = safeJSON(data);
        if (!msg) return;

        if (msg.type === "join") {
            const existingId = msg.playerId;

            // 1. TRƯỜNG HỢP RECONNECT (Quan trọng nhất)
            if (existingId && (disconnectedPlayers[existingId] || match.playerIds.includes(existingId))) {
                console.log("Player reconnecting:", existingId);
                
                // Hủy đếm ngược xóa
                if (disconnectedPlayers[existingId]) {
                    clearTimeout(disconnectedPlayers[existingId]);
                    delete disconnectedPlayers[existingId];
                }

                // Cập nhật socket mới
                ws.playerId = existingId;
                players.push({ ws, playerId: existingId });

                // Gửi trạng thái hiện tại cho người vừa quay lại
                sendToGM(ws, { type: "reconnect", matchState: match });
                broadcast({ type: "player_reconnected", playerId: existingId });
                return;
            }

            // 2. TRƯỜNG HỢP MỚI HOÀN TOÀN
            if (!existingId) {
                if (players.length >= 2) {
                    sendToGM(ws, { type: "full" });
                    ws.close();
                    return;
                }
                const newId = randomUUID();
                ws.playerId = newId;
                sendToGM(ws, { type: "assign_id", playerId: newId });
                
                players.push({ ws, playerId: newId });
                sendToGM(ws, { type: "wait", count: players.length });

                if (players.length === 2) startMatch();
            } 
            else {
                // Có ID nhưng không nằm trong danh sách trận hiện tại (ID cũ từ trận trước)
                sendToGM(ws, { type: "full" }); 
                ws.close();
            }
        }

        // GUESS LOGIC
        if (msg.type === "guess" && typeof msg.value === "number") {
            const playerIndex = match.playerIds.indexOf(ws.playerId);
            if (playerIndex === -1) return;

            match.guesses[playerIndex][match.currentTurn - 1] = msg.value;
            const turnGuesses = match.guesses.map(g => g[match.currentTurn - 1]);
            
            if (turnGuesses.length === 2 && turnGuesses.every(g => g !== undefined)) {
                broadcast({
                    type: "turn_result",
                    turn: match.currentTurn,
                    dice: match.diceRolls[match.currentTurn - 1],
                    guesses: turnGuesses
                });
                setTimeout(nextTurn, 1500);
            }
        }
    });

    ws.on("close", () => {
        if (ws.playerId) handleDisconnect({ ws, playerId: ws.playerId });
    });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Server on ${PORT}`));