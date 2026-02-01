const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;
const TURNS_PER_ROUND = 6;
const RECONNECT_TIMEOUT = 30000;
const TURN_TIME_LIMIT = 10000; 
const ANIM_SAFETY_TIMEOUT = 15000; 
const MAX_HP = 100; 

// --- DATA DEFINITIONS ---
const ITEMS = {
    "sword": { type: "damage", value: 3 },
    "heal": { type: "heal", value: 3 },
    "dodge": { type: "dodge", value: 0 }
};

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = []; 
let disconnectedPlayers = {}; 
let turnTimer = null;

let match = {
    diceRolls: [],
    guesses: [[], []],
    health: [MAX_HP, MAX_HP],
    currentTurn: 0,
    playerIds: [],
    playerLoadouts: [[], []], 
    status: "waiting",
    animsFinished: [false, false],
    roundReady: [false, false] 
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

function rollDice() {
    let set = [1, 2, 3, 4, 5, 6];
    for (let i = set.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [set[i], set[j]] = [set[j], set[i]];
    }
    return set;
}

// --- GAME LOGIC ---
function startMatch(isFirstJoin = false) {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;

    if (players.length < 2) {
        match.status = "waiting";
        return;
    }

    match.status = "preparing";
    match.diceRolls = rollDice();
    match.guesses = [[], []];

    // Reset health if new lobby or someone died
    if (isFirstJoin || match.health[0] <= 0 || match.health[1] <= 0) {
        match.health = [MAX_HP, MAX_HP];
    }

    match.currentTurn = 0; 
    match.playerIds = players.map(p => p.playerId);
    match.playerLoadouts = players.map(p => p.equipments); 
    match.roundReady = [false, false]; 
    match.animsFinished = [true, true]; 

    broadcast({
        type: "game_prepare",
        health: match.health,
        playerIds: match.playerIds,
        turn: 0
    });
    
    setTimeout(nextTurn, 1000);
}

function nextTurn() {
    if (match.status === "round_wait" || players.length < 2) return;

    match.currentTurn++;
    match.status = "playing";
    match.animsFinished = [false, false]; 
    
    broadcast({ 
        type: "turn_start", 
        turn: match.currentTurn,
        health: match.health 
    });

    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(handleAFK, TURN_TIME_LIMIT);
}

function handleAFK() {
    if (match.status !== "playing") return;
    players.forEach((p, i) => {
        if (match.guesses[i][match.currentTurn - 1] === undefined) {
            const loadout = match.playerLoadouts[i] || [];
            const randomSlot = Math.floor(Math.random() * Math.max(1, loadout.length));
            const randomDice = Math.floor(Math.random() * 6) + 1;
            match.guesses[i][match.currentTurn - 1] = { value: randomDice, slot: randomSlot };
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
    
    const p1Success = g1.value <= resultDice;
    const p2Success = g2.value <= resultDice;

    const p1ItemName = match.playerLoadouts[0][g1.slot];
    const p2ItemName = match.playerLoadouts[1][g2.slot];

    let p1Dmg = 0, p1Heal = 0, p1Dodged = false;
    let p2Dmg = 0, p2Heal = 0, p2Dodged = false;

    // Calculate P1 Intent
    if (p1Success) {
        const item = ITEMS[p1ItemName];
        if (item) {
            let val = item.value + g1.value;
            if (resultDice === 6) val = Math.floor(val * 1.5);
            if (item.type === "heal") p1Heal = val;
            else if (item.type === "damage") p1Dmg = val;
            else if (item.type === "dodge" && g1.value >= g2.value) p1Dodged = true;
        }
    }

    // Calculate P2 Intent
    if (p2Success) {
        const item = ITEMS[p2ItemName];
        if (item) {
            let val = item.value + g2.value;
            if (resultDice === 6) val = Math.floor(val * 1.5);
            if (item.type === "heal") p2Heal = val;
            else if (item.type === "damage") p2Dmg = val;
            else if (item.type === "dodge" && g2.value >= g1.value) p2Dodged = true;
        }
    }

    // Apply Dodge Logic
    if (p1Dodged) p2Dmg = 0;
    if (p2Dodged) p1Dmg = 0;

    // Apply HP changes
    match.health[0] = Math.max(0, Math.min(MAX_HP, Math.round(match.health[0] + p1Heal - p2Dmg)));
    match.health[1] = Math.max(0, Math.min(MAX_HP, Math.round(match.health[1] + p2Heal - p1Dmg)));

    let firstActor = g1.value > g2.value ? 0 : (g2.value > g1.value ? 1 : -1);

    broadcast({
        type: "turn_result",
        dice: resultDice,
        health: match.health,
        p1: { itemName: p1ItemName, guess: g1.value, success: p1Success, dmg: p1Dmg, heal: p1Heal, dodged: p1Dodged },
        p2: { itemName: p2ItemName, guess: g2.value, success: p2Success, dmg: p2Dmg, heal: p2Heal, dodged: p2Dodged },
        firstActor: firstActor
    });

    // Safety timeout to move to next turn if anims don't report back
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
        if (match.status === "results") proceedAfterAnimation();
    }, ANIM_SAFETY_TIMEOUT);
}

function proceedAfterAnimation() {
    if (turnTimer) clearTimeout(turnTimer);
    
    // Check if game should end
    if (match.health[0] <= 0 || match.health[1] <= 0 || match.currentTurn >= TURNS_PER_ROUND) {
        endRound();
    } else {
        nextTurn();
    }
}

function endRound() {
    match.status = "round_wait"; 
    match.roundReady = [false, false];
    broadcast({ type: "new_dice_round", health: match.health });
    
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
        if (match.status === "round_wait") startMatch();
    }, 15000);
}

// --- SERVER CORE ---
wss.on("connection", (ws) => {
    ws.on("message", (data) => {
        const msg = safeJSON(data);
        if (!msg) return;

        if (msg.type === "join") {
            const existingId = msg.playerId;
            const equips = msg.equipments || [];
            
            if (existingId && (disconnectedPlayers[existingId] || match.playerIds.includes(existingId))) {
                clearTimeout(disconnectedPlayers[existingId]);
                delete disconnectedPlayers[existingId];
                ws.playerId = existingId;
                players.push({ ws, playerId: existingId, equipments: equips });
                sendToGM(ws, { type: "reconnect", matchState: match });
                return;
            }

            if (players.length < 2) {
                const newId = randomUUID();
                ws.playerId = newId;
                players.push({ ws, playerId: newId, equipments: equips });
                sendToGM(ws, { type: "assign_id", playerId: newId });
                if (players.length === 2) {
                    broadcast({ type: "player_joined" });
                    startMatch(true);
                }
            }
        }

        if (msg.type === "guess" && match.status === "playing") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx !== -1 && match.guesses[pIdx][match.currentTurn - 1] === undefined) {
                match.guesses[pIdx][match.currentTurn - 1] = { value: msg.value, slot: msg.slot_index };
                checkTurnCompletion();
            }
        }

        if (msg.type === "anim_done" && match.status === "results") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx !== -1) {
                match.animsFinished[pIdx] = true;
                if (match.animsFinished[0] && match.animsFinished[1]) {
                    proceedAfterAnimation();
                }
            }
        }

        if (msg.type === "round_ready" && match.status === "round_wait") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx !== -1 && !match.roundReady[pIdx]) {
                match.roundReady[pIdx] = true;
                broadcast({ type: "opponent_ready", playerIndex: pIdx });
                if (match.roundReady[0] && match.roundReady[1]) {
                    startMatch();
                }
            }
        }
    });

    ws.on("close", () => {
        const id = ws.playerId;
        players = players.filter(p => p.playerId !== id);
        if (id) {
            disconnectedPlayers[id] = setTimeout(() => {
                delete disconnectedPlayers[id];
                // Reset match if a player leaves permanently
                if (players.length < 2) match.status = "waiting";
            }, RECONNECT_TIMEOUT);
        }
    });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));