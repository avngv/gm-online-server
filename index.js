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
    scores: [0, 0],
    currentTurn: 0,
    playerIds: [],
    playerLoadouts: [[], []], 
    status: "waiting" 
};

// --- UTILITIES ---
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

function broadcastExcept(excludeWs, obj) {
    players.forEach(p => {
        if (p.ws !== excludeWs) sendToGM(p.ws, obj);
    });
}

// --- GAME LOGIC ---
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
    match.scores = [0, 0];
    match.currentTurn = 0;
    match.playerIds = players.map(p => p.playerId);
    match.playerLoadouts = players.map(p => p.equipments); 
    
    match.status = "preparing";
    console.log("Match Found. Syncing hidden slot counts.");

    players.forEach((p, index) => {
        const opponentIndex = index === 0 ? 1 : 0;
        const opponentItemCount = players[opponentIndex].equipments.length;
        
        sendToGM(p.ws, { 
            type: "game_prepare", 
            opponentSlotCount: opponentItemCount 
        });
    });
    
    setTimeout(nextTurn, 3000);
}

function nextTurn() {
    if (match.currentTurn >= TURNS) {
        endMatch();
        return;
    }
    match.currentTurn++;
    match.status = "playing";
    broadcast({ 
        type: "turn_start", 
        turn: match.currentTurn,
        scores: match.scores 
    });
}

function endMatch() {
    match.status = "finished";
    let winnerId = (match.scores[0] > match.scores[1]) ? 0 : (match.scores[1] > match.scores[0] ? 1 : -1);

    broadcast({
        type: "match_end",
        diceRolls: match.diceRolls,
        finalScores: match.scores,
        winner: winnerId
    });

    setTimeout(() => {
        if (players.length === 2) startMatch();
        else {
            match.status = "waiting";
            broadcast({ type: "wait", count: players.length });
        }
    }, 10000);
}

function handleDisconnect(ws) {
    const playerId = ws.playerId;
    if (!playerId) return;

    console.log("Player disconnected:", playerId);
    players = players.filter(p => p.playerId !== playerId);
    broadcastExcept(ws, { type: "opponent_left" });

    disconnectedPlayers[playerId] = setTimeout(() => {
        delete disconnectedPlayers[playerId];
        if (match.playerIds.includes(playerId)) {
            match.status = "waiting";
            match.playerIds = [];
        }
    }, RECONNECT_TIMEOUT);
}

// --- SERVER CORE ---
wss.on("connection", (ws) => {
    ws.on("message", (data) => {
        const msg = safeJSON(data);
        if (!msg) return;

        if (msg.type === "join") {
            const existingId = msg.playerId;
            const clientEquips = msg.equipments || [];

            if (existingId && (disconnectedPlayers[existingId] || match.playerIds.includes(existingId))) {
                if (disconnectedPlayers[existingId]) {
                    clearTimeout(disconnectedPlayers[existingId]);
                    delete disconnectedPlayers[existingId];
                }
                
                ws.playerId = existingId;
                players.push({ ws, playerId: existingId, equipments: clientEquips });
                
                sendToGM(ws, { type: "reconnect", matchState: match, equipments: clientEquips });
                broadcastExcept(ws, { type: "player_reconnected" });
                return;
            }

            if (!existingId && players.length < 2) {
                const newId = randomUUID();
                ws.playerId = newId;
                players.push({ ws, playerId: newId, equipments: clientEquips });

                sendToGM(ws, { type: "assign_id", playerId: newId, equipments: clientEquips });

                if (players.length === 1) sendToGM(ws, { type: "wait", count: 1 });
                else if (players.length === 2) {
                    broadcast({ type: "player_joined", count: 2 });
                    startMatch();
                }
            } else {
                sendToGM(ws, { type: "full" });
                ws.close();
            }
        }

        if (msg.type === "guess") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx === -1 || match.status !== "playing") return;
            if (match.guesses[pIdx][match.currentTurn - 1] !== undefined) return;

            // USE SLOT_INDEX
            const sIdx = msg.slot_index;
            const loadout = match.playerLoadouts[pIdx];

            // Validation
            if (sIdx === undefined || sIdx < 0 || sIdx >= loadout.length) return;

            // Store guess + slot_index + the specific item string
            match.guesses[pIdx][match.currentTurn - 1] = {
                value: msg.value,
                slot: sIdx,
                item: loadout[sIdx] 
            };

            const g1 = match.guesses[0][match.currentTurn - 1];
            const g2 = match.guesses[1][match.currentTurn - 1];

            if (g1 && g2) {
                match.status = "results";
                const resultDice = match.diceRolls[match.currentTurn - 1];

                if (g1.value === resultDice) match.scores[0]++;
                if (g2.value === resultDice) match.scores[1]++;

                broadcast({
                    type: "turn_result",
                    turn: match.currentTurn,
                    dice: resultDice,
                    updatedScores: match.scores,
                    slotsUsed: [g1.slot, g2.slot] 
                });

                setTimeout(nextTurn, 2000);
            }
        }
    });

    ws.on("close", () => handleDisconnect(ws));
});

server.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));