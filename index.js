const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;
const TURNS = 6;
const RECONNECT_TIMEOUT = 30000; // 30 seconds

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = []; // Array of { ws, playerId }
let disconnectedPlayers = {}; // Dictionary of { playerId: timeout }

let match = {
    diceRolls: [],
    guesses: [[], []],
    currentTurn: 0,
    playerIds: []
};

/**
 * Sends a JSON object to a GameMaker client.
 * Appends the null terminator (\0) required by GM's buffer_read(..., buffer_string).
 */
function sendToGM(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
        const msg = JSON.stringify(obj) + "\0"; 
        ws.send(msg);
        console.log(`Sent to ${ws.playerId || "unknown"}: ${msg}`);
    }
}

/**
 * Attempts to parse incoming data from GameMaker.
 */
function safeJSON(data) {
    try {
        const str = data.toString().replace(/\0/g, ''); // Remove any null bytes from incoming
        return JSON.parse(str);
    } catch (e) {
        console.error("Parse Error. Received raw data:", data.toString());
        return null;
    }
}

function broadcast(obj) {
    players.forEach(p => {
        sendToGM(p.ws, obj);
    });
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
    match.currentTurn = 0;
    match.playerIds = players.map(p => p.playerId);

    console.log("Match started. Dice rolls:", match.diceRolls);
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

    // Clean up
    match = { diceRolls: [], guesses: [[], []], currentTurn: 0, playerIds: [] };
    players = [];
}

function handleDisconnect(player) {
    console.log("Player disconnected:", player.playerId);
    players = players.filter(p => p !== player);
    broadcast({ type: "opponent_left" });

    disconnectedPlayers[player.playerId] = setTimeout(() => {
        console.log("Cleanup timeout for player:", player.playerId);
        if (players.length < 2 && match.playerIds.length > 0) {
            endMatch();
        }
        delete disconnectedPlayers[player.playerId];
    }, RECONNECT_TIMEOUT);
}

function handleReconnect(ws, playerId) {
    console.log("Player reconnected:", playerId);

    if (disconnectedPlayers[playerId]) {
        clearTimeout(disconnectedPlayers[playerId]);
        delete disconnectedPlayers[playerId];
    }

    ws.playerId = playerId;
    players.push({ ws, playerId });

    sendToGM(ws, { type: "reconnect", matchState: match });
    broadcast({ type: "player_reconnected", playerId });
}

wss.on("connection", (ws) => {
    console.log("New WebSocket connection established");

    ws.on("message", (data) => {
        console.log("Raw incoming:", data.toString());
        const msg = safeJSON(data);
        if (!msg) return;

        // JOIN / RECONNECT LOGIC
        if (msg.type === "join") {
            // New Player
            if (!msg.playerId) {
                const newId = randomUUID();
                ws.playerId = newId;
                console.log("Assigning new ID:", newId);
                sendToGM(ws, { type: "assign_id", playerId: newId });
                
                // Add to lobby
                if (players.length < 2) {
                    players.push({ ws, playerId: newId });
                    match.playerIds.push(newId);
                    sendToGM(ws, { type: "wait", count: players.length });
                    if (players.length === 2) startMatch();
                } else {
                    sendToGM(ws, { type: "full" });
                    ws.close();
                }
                return;
            }

            // Reconnecting Player
            ws.playerId = msg.playerId;
            if (disconnectedPlayers[msg.playerId]) {
                handleReconnect(ws, msg.playerId);
            } else if (players.length < 2) {
                players.push({ ws, playerId: msg.playerId });
                match.playerIds.push(msg.playerId);
                sendToGM(ws, { type: "wait", count: players.length });
                if (players.length === 2) startMatch();
            } else {
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
            // If both players have guessed for this turn
            if (turnGuesses.length === 2 && turnGuesses.every(g => g !== undefined)) {
                const turnIndex = match.currentTurn - 1;
                broadcast({
                    type: "turn_result",
                    turn: turnIndex + 1,
                    dice: match.diceRolls[turnIndex],
                    guesses: turnGuesses
                });

                setTimeout(nextTurn, 1500);
            }
        }
    });

    ws.on("close", () => {
        if (ws.playerId) {
            handleDisconnect({ ws, playerId: ws.playerId });
        }
    });

    ws.on("error", (err) => {
        console.error("Socket Error:", err.message);
    });
});

// Important: Listen on 0.0.0.0 for Railway
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${PORT}`);
});