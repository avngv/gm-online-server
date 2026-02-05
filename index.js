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
    roundReady: [false, false],
    bonusPlayerIndex: -1 
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

    if (players.length < 2) {
        match.status = "waiting";
        return;
    }

    match.status = "preparing";
    match.diceRolls = rollDice();
    match.guesses = [[], []];
    match.bonusPlayerIndex = -1;

    if (isFirstJoin || match.health[0] <= 0 || match.health[1] <= 0) {
        match.health = [MAX_HP, MAX_HP];
    }

    match.currentTurn = 0; 
    match.playerIds = players.map(p => p.playerId);
    match.playerLoadouts = players.map(p => p.equipments); 
    match.roundReady = [false, false]; 
    match.animsFinished = [true, true]; 

    players.forEach((p, index) => {
        const opponentIndex = index === 0 ? 1 : 0;
        const opponent = players[opponentIndex];
        sendToGM(p.ws, { 
            type: "game_prepare", 
            yourIndex: index, 
            turn: 0,
            health: match.health,
            opponentSlotCount: opponent ? opponent.equipments.length : 0 
        });
    });
    
    setTimeout(nextTurn, 500);
}

function nextTurn() {
    if (match.health[0] <= 0 || match.health[1] <= 0 || match.currentTurn >= TURNS_PER_ROUND) {
        endRound();
        return;
    }

    match.currentTurn++;
    match.status = "playing";
    match.bonusPlayerIndex = -1; 
    match.animsFinished = [false, false]; 
    match.guesses[0][match.currentTurn - 1] = undefined;
    match.guesses[1][match.currentTurn - 1] = undefined;
    
    broadcast({ 
        type: "turn_start", 
        turn: match.currentTurn,
        health: match.health 
    });

    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(handleAFK, TURN_TIME_LIMIT);
}

function handleAFK() {
    if (match.status === "playing") {
        players.forEach((p, i) => {
            if (match.guesses[i][match.currentTurn - 1] === undefined) {
                match.guesses[i][match.currentTurn - 1] = { value: 1, slot: 0 };
            }
        });
        checkTurnCompletion();
    } else if (match.status === "bonus_move") {
        match.bonusPlayerIndex = -1;
        proceedAfterAnimation();
    }
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
    
    let p1Dmg = 0; let p1Heal = 0; let p1Dodged = false;
    let p2Dmg = 0; let p2Heal = 0; let p2Dodged = false;

    const p1ItemName = match.playerLoadouts[0][g1.slot];
    const p2ItemName = match.playerLoadouts[1][g2.slot];

    if (g1.value <= resultDice) {
        const item = ITEMS[p1ItemName];
        if (item.type === "heal") p1Heal = item.value + g1.value;
        else if (item.type === "damage") p1Dmg = item.value + g1.value;
        else if (item.type === "dodge" && g1.value >= g2.value) p1Dodged = true;
    }

    if (g2.value <= resultDice) {
        const item = ITEMS[p2ItemName];
        if (item.type === "heal") p2Heal = item.value + g2.value;
        else if (item.type === "damage") p2Dmg = item.value + g2.value;
        else if (item.type === "dodge" && g2.value >= g1.value) p2Dodged = true;
    }

    if (p1Dodged) { p2Dmg = 0; match.bonusPlayerIndex = 0; }
    if (p2Dodged) { p1Dmg = 0; match.bonusPlayerIndex = 1; }
    if (p1Dodged && p2Dodged) match.bonusPlayerIndex = -1; 

    match.health[0] = Math.max(0, Math.min(MAX_HP, match.health[0] + p1Heal - p2Dmg));
    match.health[1] = Math.max(0, Math.min(MAX_HP, match.health[1] + p2Heal - p1Dmg));

    let firstActor = g1.value > g2.value ? 0 : (g2.value > g1.value ? 1 : -1);

    broadcast({
        type: "turn_result",
        dice: resultDice,
        health: match.health,
        p1: { slot: g1.slot, itemName: p1ItemName, guess: g1.value, success: g1.value <= resultDice, dmg: p1Dmg, heal: p1Heal, dodged: p1Dodged },
        p2: { slot: g2.slot, itemName: p2ItemName, guess: g2.value, success: g2.value <= resultDice, dmg: p2Dmg, heal: p2Heal, dodged: p2Dodged },
        firstActor: firstActor,
        hasBonus: match.bonusPlayerIndex
    });

    match.animsFinished = [false, false]; 
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(proceedAfterAnimation, ANIM_SAFETY_TIMEOUT);
}

function proceedAfterAnimation() {
    if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
    }

    if (match.health[0] <= 0 || match.health[1] <= 0) {
        endRound();
        return;
    }

    if (match.bonusPlayerIndex !== -1) {
        match.status = "bonus_move";
        broadcast({ type: "bonus_start", playerIndex: match.bonusPlayerIndex });
        match.animsFinished = [false, false]; // Reset for bonus animation
        turnTimer = setTimeout(handleAFK, TURN_TIME_LIMIT);
        return;
    }

    if (match.currentTurn >= TURNS_PER_ROUND) {
        endRound();
    } else {
        nextTurn();
    }
}

function endRound() {
    if (match.status === "round_wait") return;
    if (turnTimer) clearTimeout(turnTimer);
    match.status = "round_wait"; 
    match.roundReady = [false, false];
    broadcast({ type: "new_dice_round", health: match.health });
    
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
                    startMatch(true); 
                }
            }
        }

        if (msg.type === "guess") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx === -1) return;

            if (match.status === "playing") {
                if (match.guesses[pIdx][match.currentTurn - 1] !== undefined) return;
                match.guesses[pIdx][match.currentTurn - 1] = { value: msg.value, slot: msg.slot_index };
                checkTurnCompletion();
            } 
            else if (match.status === "bonus_move" && pIdx === match.bonusPlayerIndex) {
                const resultDice = match.diceRolls[match.currentTurn - 1];
                const itemName = match.playerLoadouts[pIdx][msg.slot_index];
                const item = ITEMS[itemName];
                let dmg = 0;
                let success = (msg.value <= resultDice);

                if (success && item.type === "damage") {
                    dmg = item.value + msg.value;
                    const targetIdx = pIdx === 0 ? 1 : 0;
                    match.health[targetIdx] = Math.max(0, match.health[targetIdx] - dmg);
                }

                broadcast({ 
                    type: "bonus_result", 
                    attackerIndex: pIdx, 
                    itemName: itemName,
                    slot_index: msg.slot_index,
                    guess: msg.value,
                    success: success,
                    dmg: dmg, 
                    health: match.health 
                });

                match.bonusPlayerIndex = -1; // End bonus state immediately
                match.animsFinished = [false, false]; // Reset to wait for bonus anim_done
                
                if (turnTimer) clearTimeout(turnTimer);
                turnTimer = setTimeout(proceedAfterAnimation, 5000); 
            }
        }

        if (msg.type === "anim_done") {
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
                if (match.roundReady[0] && match.roundReady[1]) startMatch(); 
            }
        }
    });

    ws.on("close", () => {
        const playerId = ws.playerId;
        players = players.filter(p => p.playerId !== playerId);
        disconnectedPlayers[playerId] = setTimeout(() => delete disconnectedPlayers[playerId], RECONNECT_TIMEOUT);
    });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Server Online`));