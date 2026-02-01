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
    "heal": { type: "heal", value: 3 },
    "dodge": { type: "dodge", value: 0 }
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
    bonusPlayerIndex: -1 
};

// --- UTILITIES ---
function sendToGM(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj) + "\0");
    }
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
    console.log("Dice Shuffled for Round:", set);
    return set;
}

// --- GAME FLOW ---
function startMatch(isFirstJoin = false) {
    if (turnTimer) clearTimeout(turnTimer);
    match.status = "preparing";
    match.diceRolls = rollDice();
    match.guesses = [[], []];
    match.bonusPlayerIndex = -1;
    match.currentTurn = 0; 
    
    if (isFirstJoin || match.health[0] <= 0 || match.health[1] <= 0) {
        match.health = [MAX_HP, MAX_HP];
    }

    match.playerIds = players.map(p => p.playerId);
    match.playerLoadouts = players.map(p => p.equipments); 

    players.forEach((p, index) => {
        sendToGM(p.ws, { 
            type: "game_prepare", 
            yourIndex: index, 
            health: match.health,
            opponentSlotCount: players[index === 0 ? 1 : 0]?.equipments.length || 0
        });
    });
    
    setTimeout(nextTurn, 1000);
}

function nextTurn() {
    if (players.length < 2) return;
    match.currentTurn++;
    match.status = "playing";
    match.bonusPlayerIndex = -1;
    match.animsFinished = [false, false]; 
    
    broadcast({ type: "turn_start", turn: match.currentTurn, health: match.health });

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
    const p1ItemName = match.playerLoadouts[0][g1.slot];
    const p2ItemName = match.playerLoadouts[1][g2.slot];

    let p1Dmg = 0, p1Heal = 0, p1Dodged = false;
    let p2Dmg = 0, p2Heal = 0, p2Dodged = false;

    // Resolve Player 1
    if (g1.value <= resultDice) {
        const item = ITEMS[p1ItemName];
        if (item.type === "heal") p1Heal = item.value + g1.value;
        else if (item.type === "damage") p1Dmg = item.value + g1.value;
        else if (item.type === "dodge" && g1.value >= g2.value) p1Dodged = true;
    }

    // Resolve Player 2
    if (g2.value <= resultDice) {
        const item = ITEMS[p2ItemName];
        if (item.type === "heal") p2Heal = item.value + g2.value;
        else if (item.type === "damage") p2Dmg = item.value + g2.value;
        else if (item.type === "dodge" && g2.value >= g1.value) p2Dodged = true;
    }

    // Dodge Mitigation
    if (p1Dodged) { p2Dmg = 0; match.bonusPlayerIndex = 0; }
    if (p2Dodged) { p1Dmg = 0; match.bonusPlayerIndex = 1; }

    match.health[0] = Math.max(0, Math.min(MAX_HP, Math.round(match.health[0] + p1Heal - p2Dmg)));
    match.health[1] = Math.max(0, Math.min(MAX_HP, Math.round(match.health[1] + p2Heal - p1Dmg)));

    // firstActor logic for GameMaker: -1 = simultaneous, 0 = P1, 1 = P2
    let firstActor = g1.value > g2.value ? 0 : (g2.value > g1.value ? 1 : -1);

    broadcast({
        type: "turn_result",
        dice: resultDice,
        health: match.health,
        p1: { itemName: p1ItemName, slot: g1.slot, guess: g1.value, success: g1.value <= resultDice, dmg: p1Dmg, heal: p1Heal, dodged: p1Dodged },
        p2: { itemName: p2ItemName, slot: g2.slot, guess: g2.value, success: g2.value <= resultDice, dmg: p2Dmg, heal: p2Heal, dodged: p2Dodged },
        firstActor: firstActor,
        hasBonus: match.bonusPlayerIndex
    });

    turnTimer = setTimeout(proceedAfterAnimation, ANIM_SAFETY_TIMEOUT);
}

function proceedAfterAnimation() {
    if (turnTimer) clearTimeout(turnTimer);
    
    if (match.bonusPlayerIndex !== -1 && match.health[0] > 0 && match.health[1] > 0) {
        match.status = "bonus_move";
        broadcast({ type: "bonus_start", playerIndex: match.bonusPlayerIndex });
        return;
    }

    if (match.health[0] <= 0 || match.health[1] <= 0 || match.currentTurn >= TURNS_PER_ROUND) {
        match.status = "round_wait";
        broadcast({ type: "new_dice_round", health: match.health });
        setTimeout(startMatch, 5000); 
    } else {
        nextTurn();
    }
}

// --- SERVER CORE ---
wss.on("connection", (ws) => {
    ws.on("message", (data) => {
        const str = data.toString().replace(/\0/g, '');
        let msg;
        try { msg = JSON.parse(str); } catch (e) { return; }

        if (msg.type === "join") {
            const newId = msg.playerId || randomUUID();
            ws.playerId = newId;
            players.push({ ws, playerId: newId, equipments: msg.equipments || [] });
            sendToGM(ws, { type: "assign_id", playerId: newId, equipments: msg.equipments });
            if (players.length === 2) startMatch(true);
        }

        if (msg.type === "guess") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx === -1) return;

            if (match.status === "playing") {
                if (match.guesses[pIdx][match.currentTurn - 1] === undefined) {
                    match.guesses[pIdx][match.currentTurn - 1] = { value: msg.value, slot: msg.slot_index };
                    checkTurnCompletion();
                }
            } 
            else if (match.status === "bonus_move" && pIdx === match.bonusPlayerIndex) {
                const resultDice = match.diceRolls[match.currentTurn - 1];
                const itemName = match.playerLoadouts[pIdx][msg.slot_index];
                const success = (msg.value <= resultDice);
                let dmg = (success && ITEMS[itemName].type === "damage") ? (ITEMS[itemName].value + msg.value) : 0;

                const targetIdx = pIdx === 0 ? 1 : 0;
                match.health[targetIdx] = Math.max(0, match.health[targetIdx] - dmg);

                broadcast({ 
                    type: "bonus_result", 
                    attackerIndex: pIdx, 
                    itemName: itemName,
                    slot_index: msg.slot_index,
                    success: success,
                    dmg: dmg, 
                    health: match.health 
                });

                match.bonusPlayerIndex = -1;
                setTimeout(proceedAfterAnimation, 4000); 
            }
        }

        if (msg.type === "anim_done") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx !== -1) {
                match.animsFinished[pIdx] = true;
                if (match.animsFinished[0] && match.animsFinished[1]) proceedAfterAnimation();
            }
        }
    });

    ws.on("close", () => {
        players = players.filter(p => p.ws !== ws);
        match.status = "waiting";
    });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Server Online`));