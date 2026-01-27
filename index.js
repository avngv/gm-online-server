const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const TURNS = 6; // number of turns in a match

// Create HTTP server (needed for WebSocket)
const server = http.createServer();

const wss = new WebSocket.Server({ server });

// Keep track of connected players
let players = [];

// Match state
let match = {
    diceRolls: [],        // shuffled dice values [1,2,3,4,5,6]
    guesses: [[], []],    // players' guesses per turn
    currentTurn: 0
};

// Safely parse JSON from GameMaker
function safeJSON(data) {
    try {
        if (typeof data === "string") return JSON.parse(data);
        const text = Buffer.from(data).toString("utf8");
        return JSON.parse(text);
    } catch (e) {
        console.log("Invalid JSON received:", data);
        return null;
    }
}

// Broadcast to all connected players
function broadcast(obj) {
    const msg = JSON.stringify(obj);
    players.forEach(p => {
        if (p.readyState === WebSocket.OPEN) {
            p.send(msg);
        }
    });
}

// Shuffle dice array [1,2,3,4,5,6]
function rollDice() {
    const arr = [1, 2, 3, 4, 5, 6];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Start a new match
function startMatch() {
    match.diceRolls = rollDice();
    match.guesses = [[], []];
    match.currentTurn = 0;

    console.log("Match dice rolls:", match.diceRolls);

    // Tell players the match is starting
    broadcast({ type: "match_start", turns: TURNS });

    // Start first turn
    nextTurn();
}

// Handle next turn
function nextTurn() {
    if (match.currentTurn >= TURNS) {
        endMatch();
        return;
    }

    const turnIndex = match.currentTurn;

    // Inform players that dice has been rolled for this turn
    broadcast({ type: "turn_start", turn: turnIndex + 1 });

    match.currentTurn++;
}

// End the match and calculate winner
function endMatch() {
    const results = [0, 0]; // correct guesses per player

    for (let i = 0; i < TURNS; i++) {
        for (let p = 0; p < players.length; p++) {
            if (match.guesses[p][i] === match.diceRolls[i]) {
                results[p]++;
            }
        }
    }

    let winner = null;
    if (results[0] > results[1]) winner = 0;
    else if (results[1] > results[0]) winner = 1;
    // tie => winner = null

    broadcast({
        type: "match_end",
        diceRolls: match.diceRolls,
        guesses: match.guesses,
        results,
        winner
    });
}

wss.on("connection", (ws) => {
    console.log("Player connected");

    if (players.length >= 2) {
        ws.send(JSON.stringify({ type: "full" }));
        ws.close();
        return;
    }

    players.push(ws);
    ws.send(JSON.stringify({ type: "wait", count: players.length }));

    // If 2 players connected, start match
    if (players.length === 2) {
        startMatch();
    }

    ws.on("message", (data) => {
        const msg = safeJSON(data);
        if (!msg) return;

        console.log("CLIENT:", msg);

        // Handle player's guess
        if (msg.type === "guess" && typeof msg.value === "number") {
            const playerIndex = players.indexOf(ws);
            if (playerIndex === -1) return;

            // Save guess for the current turn
            match.guesses[playerIndex][match.currentTurn - 1] = msg.value;

            // Check if both players guessed for this turn
            const turnGuesses = match.guesses.map(g => g[match.currentTurn - 1]);
            if (turnGuesses.every(g => g !== undefined)) {
                // Reveal dice result for this turn
                const turnIndex = match.currentTurn - 1;
                broadcast({
                    type: "turn_result",
                    turn: turnIndex + 1,
                    dice: match.diceRolls[turnIndex],
                    guesses: turnGuesses
                });

                // Move to next turn after short delay
                setTimeout(nextTurn, 1000);
            }
        }
    });

    ws.on("close", () => {
        console.log("Player disconnected");
        players = players.filter(p => p !== ws);

        // Notify remaining player
        broadcast({ type: "opponent_left" });

        // Reset match if a player leaves
        match = {
            diceRolls: [],
            guesses: [[], []],
            currentTurn: 0
        };
    });
});

server.listen(PORT, () => {
    console.log("Server running on port", PORT);
});
