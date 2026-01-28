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
    status: "waiting" // waiting, playing, results, finished
};

/**
 * Sends a JSON object to a GameMaker client with null terminator.
 */
function sendToGM(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const msg = JSON.stringify(obj) + "\0"; 
        ws.send(msg);
    }
}

/**
 * Safely parses incoming data from GameMaker buffers.
 */
function safeJSON(data) {
    try {
        const str = data.toString().replace(/\0/g, '');
        return JSON.parse(str);
    } catch (e) { return null; }
}

function broadcast(obj) {
    players.forEach(p => sendToGM(p.ws, obj));
}

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
    match.status = "playing";

    console.log("Match started. Dice:", match.diceRolls);
    broadcast({ type: "match_start", turns: TURNS });
    nextTurn();
}

function nextTurn() {
    if (match.currentTurn >= TURNS) {
        endMatch();
        return;
    }
    match.currentTurn++;
    match.status = "playing"; // Allow guessing
    broadcast({ 
        type: "turn_start", 
        turn: match.currentTurn,
        scores: match.scores 
    });
}

function endMatch() {
    match.status = "finished";
    let winnerId = -1; // Draw
    if (match.scores[0] > match.scores[1]) winnerId = 0;
    else if (match.scores[1] > match.scores[0]) winnerId = 1;

    broadcast({
        type: "match_end",
        diceRolls: match.diceRolls,
        finalScores: match.scores,
        winner: winnerId
    });

    console.log("Match ended. Restarting in 10s...");
    
    // Auto-restart logic
    setTimeout(() => {
        if (players.length === 2) {
            startMatch();
        } else {
            match.status = "waiting";
            broadcast({ type: "wait", count: players.length });
        }
    }, 10000);
}

function handleDisconnect(player) {
    console.log("Player disconnected:", player.playerId);
    players = players.filter(p => p.playerId !== player.playerId);
    broadcast({ type: "opponent_left" });

    disconnectedPlayers[player.playerId] = setTimeout(() => {
        console.log("Cleaning up player record:", player.playerId);
        delete disconnectedPlayers[player.playerId];
    }, RECONNECT_TIMEOUT);
}

wss.on("connection", (ws) => {
    console.log("New connection established");

    ws.on("message", (data) => {
        const msg = safeJSON(data);
        if (!msg) return;

        // --- JOIN / RECONNECT ---
        if (msg.type === "join") {
            const existingId = msg.playerId;

            if (existingId && (disconnectedPlayers[existingId] || match.playerIds.includes(existingId))) {
                if (disconnectedPlayers[existingId]) {
                    clearTimeout(disconnectedPlayers[existingId]);
                    delete disconnectedPlayers[existingId];
                }
                ws.playerId = existingId;
                players.push({ ws, playerId: existingId });
                sendToGM(ws, { type: "reconnect", matchState: match });
                broadcast({ type: "player_reconnected", playerId: existingId });
                return;
            }

            if (!existingId && players.length < 2) {
                const newId = randomUUID();
                ws.playerId = newId;
                sendToGM(ws, { type: "assign_id", playerId: newId });
                players.push({ ws, playerId: newId });
                sendToGM(ws, { type: "wait", count: players.length });
                if (players.length === 2) startMatch();
            } else {
                sendToGM(ws, { type: "full" });
                ws.close();
            }
        }

        // --- GUESS LOGIC ---
        if (msg.type === "guess" && typeof msg.value === "number") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            // Ignore if player not in match or if it's not the "playing" phase
            if (pIdx === -1 || match.status !== "playing") return;

            // Prevent double-guessing in the same turn
            if (match.guesses[pIdx][match.currentTurn - 1] !== undefined) return;

            match.guesses[pIdx][match.currentTurn - 1] = msg.value;
            const turnGuesses = match.guesses.map(g => g[match.currentTurn - 1]);

            // If both players have guessed
            if (turnGuesses.length === 2 && turnGuesses.every(g => g !== undefined)) {
                match.status = "results"; // Block further guesses
                const resultDice = match.diceRolls[match.currentTurn - 1];

                // Calculate turn score
                if (turnGuesses[0] === resultDice) match.scores[0]++;
                if (turnGuesses[1] === resultDice) match.scores[1]++;

                broadcast({
                    type: "turn_result",
                    turn: match.currentTurn,
                    dice: resultDice,
                    guesses: turnGuesses,
                    updatedScores: match.scores
                });

                // Wait 3 seconds so GameMaker can play animations
                setTimeout(nextTurn, 3000);
            }
        }
    });

    ws.on("close", () => {
        if (ws.playerId) handleDisconnect({ ws, playerId: ws.playerId });
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Dice Server running on port ${PORT}`);
});