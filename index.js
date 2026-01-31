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
    status: "waiting" 
};

// --- UTILITY FUNCTIONS ---

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

// Sends to everyone EXCEPT the person who triggered it (prevents UI double-popups)
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
    match.status = "preparing";

    console.log("Match Found. Preparing game...");
    
    // FIXED: Removed playerIds from broadcast to keep them private
    broadcast({ type: "game_prepare" }); 
    
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
    let winnerId = -1;
    if (match.scores[0] > match.scores[1]) winnerId = 0;
    else if (match.scores[1] > match.scores[0]) winnerId = 1;

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
    
    // FIXED: Removed playerId from broadcast to keep it private
    broadcastExcept(ws, { type: "opponent_left" });

    disconnectedPlayers[playerId] = setTimeout(() => {
        console.log("Grace period expired for:", playerId);
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

        // JOIN / RECONNECT LOGIC
        if (msg.type === "join") {
            const existingId = msg.playerId;

            if (existingId && (disconnectedPlayers[existingId] || match.playerIds.includes(existingId))) {
                if (disconnectedPlayers[existingId]) {
                    clearTimeout(disconnectedPlayers[existingId]);
                    delete disconnectedPlayers[existingId];
                }
                
                ws.playerId = existingId;
                players.push({ ws, playerId: existingId });
                
                console.log("Player reconnected:", existingId);
                sendToGM(ws, { type: "reconnect", matchState: match });
                
                // FIXED: Notify opponent without leaking the ID
                broadcastExcept(ws, { type: "player_reconnected" });
                return;
            }

            if (!existingId && players.length < 2) {
                const newId = randomUUID();
                ws.playerId = newId;
                
                // Only the owner knows this ID
                sendToGM(ws, { type: "assign_id", playerId: newId });
                
                players.push({ ws, playerId: newId });

                if (players.length === 1) {
                    sendToGM(ws, { type: "wait", count: 1 });
                } else if (players.length === 2) {
                    broadcast({ type: "player_joined", count: 2 });
                    startMatch();
                }
            } else {
                sendToGM(ws, { type: "full" });
                ws.close();
            }
        }

        // GUESS LOGIC
        if (msg.type === "guess" && typeof msg.value === "number") {
            // FIXED: Server uses ws.playerId (the socket) to identify the player.
            // Even if a player tries to send someone else's ID in the packet, it is ignored.
            const pIdx = match.playerIds.indexOf(ws.playerId);
            
            if (pIdx === -1 || match.status !== "playing") return;
            if (match.guesses[pIdx][match.currentTurn - 1] !== undefined) return;

            match.guesses[pIdx][match.currentTurn - 1] = msg.value;
            const turnGuesses = [match.guesses[0][match.currentTurn-1], match.guesses[1][match.currentTurn-1]];

            if (turnGuesses[0] !== undefined && turnGuesses[1] !== undefined) {
                match.status = "results";
                const resultDice = match.diceRolls[match.currentTurn - 1];

                if (turnGuesses[0] === resultDice) match.scores[0]++;
                if (turnGuesses[1] === resultDice) match.scores[1]++;

                broadcast({
                    type: "turn_result",
                    turn: match.currentTurn,
                    dice: resultDice,
                    guesses: turnGuesses,
                    updatedScores: match.scores
                });

                setTimeout(nextTurn, 2000);
            }
        }
        
        if (msg.type === "quit") {
            ws.close();
        }
    });

    ws.on("close", () => {
        handleDisconnect(ws);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});