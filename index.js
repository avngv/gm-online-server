const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;
const TURNS = 6;
const RECONNECT_TIMEOUT = 30000; // 30 seconds

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = []; // { ws, playerId }
let disconnectedPlayers = {}; // { playerId: timeout }

let match = {
    diceRolls: [],
    guesses: [[], []],
    currentTurn: 0,
    playerIds: []
};

function safeJSON(data) {
    try {
        if (typeof data === "string") return JSON.parse(data);
        return JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
        return null;
    }
}

function broadcast(obj) {
    const msg = JSON.stringify(obj);
    players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
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

    console.log("Match dice rolls:", match.diceRolls);
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

    // reset
    match = { diceRolls: [], guesses: [[], []], currentTurn: 0, playerIds: [] };
    players = [];
}

function handleDisconnect(player) {
    console.log("Player disconnected:", player.playerId);
    players = players.filter(p => p !== player);
    broadcast({ type: "opponent_left" });

    disconnectedPlayers[player.playerId] = setTimeout(() => {
        console.log("Match ended due to timeout for player:", player.playerId);
        if (players.length < 2) endMatch();
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

    ws.send(JSON.stringify({ type: "reconnect", matchState: match }));
    broadcast({ type: "player_reconnected", playerId });
}

wss.on("connection", (ws) => {
    console.log("New WebSocket connected");

    ws.on("message", (data) => {
        const msg = safeJSON(data);
        if (!msg) return;

        // Join / reconnect
        if (msg.type === "join") {
            if (!msg.playerId) {
                const newId = randomUUID();
                ws.playerId = newId;
                ws.send(JSON.stringify({ type: "assign_id", playerId: newId }));
                return;
            }

            ws.playerId = msg.playerId;

            if (disconnectedPlayers[msg.playerId]) {
                handleReconnect(ws, msg.playerId);
                return;
            }

            if (players.length >= 2) {
                ws.send(JSON.stringify({ type: "full" }));
                ws.close();
                return;
            }

            players.push({ ws, playerId: msg.playerId });
            match.playerIds.push(msg.playerId);
            ws.send(JSON.stringify({ type: "wait", count: players.length }));

            if (players.length === 2) startMatch();
            return;
        }

        // Guess
        if (msg.type === "guess" && typeof msg.value === "number") {
            const playerIndex = match.playerIds.indexOf(ws.playerId);
            if (playerIndex === -1) return;

            match.guesses[playerIndex][match.currentTurn - 1] = msg.value;

            const turnGuesses = match.guesses.map(g => g[match.currentTurn - 1]);
            if (turnGuesses.every(g => g !== undefined)) {
                const turnIndex = match.currentTurn - 1;
                broadcast({
                    type: "turn_result",
                    turn: turnIndex + 1,
                    dice: match.diceRolls[turnIndex],
                    guesses: turnGuesses
                });

                setTimeout(nextTurn, 1000);
            }
        }
    });

    ws.on("close", () => {
        if (!ws.playerId) return;
        handleDisconnect({ ws, playerId: ws.playerId });
    });
});

server.listen(PORT, () => {
    console.log("Server running on port", PORT);
});
