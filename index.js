const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;
const TURNS_PER_ROUND = 6;
const TURN_TIME_LIMIT = 10000; 
const ANIM_SAFETY_TIMEOUT = 15000; 
const MAX_HP = 100;

const ITEMS = {
    "sword": { type: "damage", value: 3 },
    "heal": { type: "heal", value: 3 }
};

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let players = []; 
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

// --- RESET LOGIC ---
function resetMatchData() {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
    match.status = "waiting";
    match.health = [MAX_HP, MAX_HP];
    match.currentTurn = 0;
    match.guesses = [[], []];
    match.playerIds = [];
    match.playerLoadouts = [[], []];
}

function startMatch(isFirstBattleStart = false) {
    if (players.length < 2) return;

    if (isFirstBattleStart) match.health = [MAX_HP, MAX_HP];

    match.status = "preparing";
    match.diceRolls = rollDice();
    match.guesses = [[], []];
    match.currentTurn = 0; 
    match.playerIds = players.map(p => p.playerId);
    match.playerLoadouts = players.map(p => p.equipments); 
    match.roundReady = [false, false]; 
    match.animsFinished = [true, true]; 

    players.forEach((p, index) => {
        sendToGM(p.ws, { 
            type: "game_prepare", 
            yourIndex: index, 
            health: match.health 
        });
    });
    
    setTimeout(nextTurn, 1000);
}

function nextTurn() {
    if (players.length < 2) return;
    if (match.health[0] <= 0 || match.health[1] <= 0 || match.currentTurn >= TURNS_PER_ROUND) {
        endRound();
        return;
    }

    match.currentTurn++;
    match.status = "playing";
    match.animsFinished = [false, false]; 
    
    broadcast({ type: "turn_start", turn: match.currentTurn, health: match.health });

    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(handleAFK, TURN_TIME_LIMIT);
}

function handleAFK() {
    if (match.status !== "playing" || players.length < 2) return;
    players.forEach((p, i) => {
        if (match.guesses[i][match.currentTurn - 1] === undefined) {
            match.guesses[i][match.currentTurn - 1] = { value: 1, slot: 0 };
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

    let p1Dmg = 0; let p1Heal = 0;
    let p2Dmg = 0; let p2Heal = 0;

    const p1ItemName = match.playerLoadouts[0][g1.slot] || "none";
    const p2ItemName = match.playerLoadouts[1][g2.slot] || "none";

    if (p1Success) {
        const item = ITEMS[p1ItemName];
        let power = (item ? item.value : 0) + g1.value;
        if (resultDice === 6) power = Math.floor(power * 1.5);
        if (item && item.type === "heal") { p1Heal = power; match.health[0] += p1Heal; }
        else if (item && item.type === "damage") { p1Dmg = power; match.health[1] -= p1Dmg; }
    }

    if (p2Success) {
        const item = ITEMS[p2ItemName];
        let power = (item ? item.value : 0) + g2.value;
        if (resultDice === 6) power = Math.floor(power * 1.5);
        if (item && item.type === "heal") { p2Heal = power; match.health[1] += p2Heal; }
        else if (item && item.type === "damage") { p2Dmg = power; match.health[0] -= p2Dmg; }
    }

    match.health[0] = Math.round(Math.max(0, Math.min(MAX_HP, match.health[0])));
    match.health[1] = Math.round(Math.max(0, Math.min(MAX_HP, match.health[1])));

    console.log(`P1: ${p1ItemName} | P2: ${p2ItemName} | HP: ${match.health}`);

    broadcast({
        type: "turn_result",
        dice: resultDice,
        health: match.health,
        p1: { slot: g1.slot, itemName: p1ItemName, guess: g1.value, success: p1Success, dmg: p1Dmg, heal: p1Heal },
        p2: { slot: g2.slot, itemName: p2ItemName, guess: g2.value, success: p2Success, dmg: p2Dmg, heal: p2Heal },
        firstActor: (g1.value > g2.value) ? 0 : (g2.value > g1.value ? 1 : -1)
    });

    if (match.health[0] <= 0 || match.health[1] <= 0) {
        setTimeout(() => { if (match.status === "results") endRound(); }, 3000);
    } else if (match.currentTurn < TURNS_PER_ROUND) {
        turnTimer = setTimeout(() => { if (match.status === "results") nextTurn(); }, ANIM_SAFETY_TIMEOUT);
    } else {
        setTimeout(() => { if (match.status === "results") endRound(); }, 2000);
    }
}

function endRound() {
    match.status = "round_wait"; 
    match.roundReady = [false, false];
    broadcast({ type: "new_dice_round", health: match.health });
}

wss.on("connection", (ws) => {
    console.log("New connection attempt...");

    ws.on("message", (data) => {
        const msg = safeJSON(data);
        if (!msg) return;

        if (msg.type === "join") {
            ws.playerId = randomUUID();
            players.push({ ws, playerId: ws.playerId, equipments: msg.equipments || [] });
            console.log(`Player joined. Count: ${players.length}`);
            
            if (players.length === 2) {
                match.playerIds = players.map(p => p.playerId);
                startMatch(true);
            }
        }

        if (msg.type === "guess" && match.status === "playing") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx !== -1 && match.guesses[pIdx][match.currentTurn - 1] === undefined) {
                match.guesses[pIdx][match.currentTurn - 1] = { value: msg.value, slot: msg.slot_index };
                checkTurnCompletion();
            }
        }

        // ... rest of the handlers (anim_done, round_ready) ...
    });

    ws.on("close", () => {
        players = players.filter(p => p.ws !== ws);
        console.log("Player left. Resetting.");
        resetMatchData();
    });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Server live on ${PORT}`));