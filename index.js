const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;
const TURNS = 6;
const RECONNECT_TIMEOUT = 30000;
const TURN_TIME_LIMIT = 10000; // 10 Seconds for choosing
const ANIM_SAFETY_TIMEOUT = 5000; // 5 Seconds max for animation phase

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = []; 
let disconnectedPlayers = {}; 
let turnTimer = null;

let match = {
    diceRolls: [],
    guesses: [[], []],
    scores: [0, 0],
    currentTurn: 0,
    playerIds: [],
    playerLoadouts: [[], []], 
    status: "waiting",
    animsFinished: [false, false] 
};

// --- UTILITIES ---
function sendToGM(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj) + "\0");
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

// --- GAME LOGIC ---
function rollDice() {
    return Array.from({length: TURNS}, () => Math.floor(Math.random() * 6) + 1);
}

function startMatch() {
    match.diceRolls = rollDice();
    match.guesses = [[], []];
    match.scores = [0, 0];
    match.currentTurn = 0;
    match.playerIds = players.map(p => p.playerId);
    match.playerLoadouts = players.map(p => p.equipments); 
    
    match.status = "preparing";
    console.log("Match starting...");

    players.forEach((p, index) => {
        const opponentIndex = index === 0 ? 1 : 0;
        sendToGM(p.ws, { 
            type: "game_prepare", 
            yourIndex: index, 
            opponentSlotCount: players[opponentIndex].equipments.length 
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
    match.animsFinished = [false, false]; 
    
    broadcast({ 
        type: "turn_start", 
        turn: match.currentTurn,
        scores: match.scores 
    });

    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(handleAFK, TURN_TIME_LIMIT);
}

function handleAFK() {
    console.log("Selection timer expired. Forcing randoms.");
    players.forEach((p, i) => {
        if (match.guesses[i][match.currentTurn - 1] === undefined) {
            const loadout = match.playerLoadouts[i];
            const randomSlot = Math.floor(Math.random() * loadout.length);
            const randomDice = Math.floor(Math.random() * 6) + 1;

            match.guesses[i][match.currentTurn - 1] = {
                value: randomDice,
                slot: randomSlot,
                item: loadout[randomSlot],
                afk: true
            };
        }
    });
    checkTurnCompletion();
}

function checkTurnCompletion() {
    const g1 = match.guesses[0][match.currentTurn - 1];
    const g2 = match.guesses[1][match.currentTurn - 1];

    if (g1 && g2) {
        if (turnTimer) clearTimeout(turnTimer);
        processResults(g1, g2);
    }
}

function processResults(g1, g2) {
    match.status = "results";
    const resultDice = match.diceRolls[match.currentTurn - 1];

    // SUCCESS LOGIC: Guess <= Dice
    const p1Success = g1.value <= resultDice;
    const p2Success = g2.value <= resultDice;

    if (p1Success) match.scores[0]++;
    if (p2Success) match.scores[1]++;

    let firstActor = -1;
    if (g1.value > g2.value) firstActor = 0;
    else if (g2.value > g1.value) firstActor = 1;

    broadcast({
        type: "turn_result",
        dice: resultDice,
        updatedScores: match.scores,
        p1: { 
            slot: g1.slot, 
            itemName: match.playerLoadouts[0][g1.slot],
            guess: g1.value, 
            success: p1Success, 
            afk: !!g1.afk 
        },
        p2: { 
            slot: g2.slot, 
            itemName: match.playerLoadouts[1][g2.slot],
            guess: g2.value, 
            success: p2Success, 
            afk: !!g2.afk 
        },
        firstActor: firstActor
    });

    // Start Safety Timeout for Animation Phase
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
        if (match.status === "results") {
            console.log("Animation safety timeout hit.");
            nextTurn();
        }
    }, ANIM_SAFETY_TIMEOUT);
}

function endMatch() {
    match.status = "finished";
    let winnerId = (match.scores[0] > match.scores[1]) ? 0 : (match.scores[1] > match.scores[0] ? 1 : -1);

    broadcast({
        type: "match_end",
        finalScores: match.scores,
        winner: winnerId
    });

    setTimeout(() => {
        if (players.length === 2) startMatch();
        else match.status = "waiting";
    }, 5000);
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
                clearTimeout(disconnectedPlayers[existingId]);
                delete disconnectedPlayers[existingId];
                ws.playerId = existingId;
                players.push({ ws, playerId: existingId, equipments: clientEquips });
                sendToGM(ws, { type: "reconnect", matchState: match });
                return;
            }

            if (players.length < 2) {
                const newId = randomUUID();
                ws.playerId = newId;
                players.push({ ws, playerId: newId, equipments: clientEquips });
                sendToGM(ws, { type: "assign_id", playerId: newId, equipments: clientEquips });

                if (players.length === 2) {
                    broadcast({ type: "player_joined" });
                    startMatch();
                }
            }
        }

        if (msg.type === "guess" && match.status === "playing") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx === -1 || match.guesses[pIdx][match.currentTurn - 1] !== undefined) return;

            match.guesses[pIdx][match.currentTurn - 1] = {
                value: msg.value,
                slot: msg.slot_index,
                item: match.playerLoadouts[pIdx][msg.slot_index]
            };
            checkTurnCompletion();
        }

        if (msg.type === "anim_done" && match.status === "results") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx !== -1) {
                match.animsFinished[pIdx] = true;
                if (match.animsFinished[0] && match.animsFinished[1]) {
                    if (turnTimer) clearTimeout(turnTimer);
                    nextTurn();
                }
            }
        }
    });

    ws.on("close", () => {
        const playerId = ws.playerId;
        players = players.filter(p => p.playerId !== playerId);
        disconnectedPlayers[playerId] = setTimeout(() => delete disconnectedPlayers[playerId], RECONNECT_TIMEOUT);
    });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));