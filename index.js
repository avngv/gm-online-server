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
    status: "waiting", // waiting | lobby_ready | preparing | playing | results | bonus_move | round_wait
    animsFinished: [false, false],
    roundReady: [false, false],
    bonusPlayerIndex: -1,
    playerReady: [false, false]
};

// --- UTILITIES ---
function sendToGM(ws, obj)
{
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj) + "\0");
    }
}

function safeJSON(data)
{
    try {
        const str = data.toString().replace(/\0/g, '');
        return JSON.parse(str);
    } catch {
        return null;
    }
}

function broadcast(obj)
{
    players.forEach(p => sendToGM(p.ws, obj));
}

function rollDice()
{
    let set = [1, 2, 3, 4, 5, 6];
    for (let i = set.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [set[i], set[j]] = [set[j], set[i]];
    }
    return set;
}

// --- GAME LOGIC ---
function startMatch(isFirstJoin = false)
{
    if (turnTimer) clearTimeout(turnTimer);
    if (players.length < 2) return;

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

function nextTurn()
{
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

function handleAFK()
{
    if (match.status === "playing") {
        players.forEach((p, i) => {
            if (match.guesses[i][match.currentTurn - 1] === undefined) {
                match.guesses[i][match.currentTurn - 1] = { value: 1, slot: 0 };
            }
        });
        checkTurnCompletion();
    }
    else if (match.status === "bonus_move") {
        match.bonusPlayerIndex = -1;
        proceedAfterAnimation();
    }
}

function checkTurnCompletion()
{
    const g1 = match.guesses[0][match.currentTurn - 1];
    const g2 = match.guesses[1][match.currentTurn - 1];
    if (g1 && g2) {
        if (turnTimer) clearTimeout(turnTimer);
        processResults(g1, g2);
    }
}

function processResults(g1, g2)
{
    match.status = "results";
    const dice = match.diceRolls[match.currentTurn - 1];

    let p1Dmg = 0, p1Heal = 0, p1Dodged = false;
    let p2Dmg = 0, p2Heal = 0, p2Dodged = false;

    const p1Item = ITEMS[match.playerLoadouts[0][g1.slot]];
    const p2Item = ITEMS[match.playerLoadouts[1][g2.slot]];

    if (g1.value <= dice) {
        if (p1Item.type === "heal") p1Heal = p1Item.value + g1.value;
        if (p1Item.type === "damage") p1Dmg = p1Item.value + g1.value;
        if (p1Item.type === "dodge" && g1.value >= g2.value) p1Dodged = true;
    }

    if (g2.value <= dice) {
        if (p2Item.type === "heal") p2Heal = p2Item.value + g2.value;
        if (p2Item.type === "damage") p2Dmg = p2Item.value + g2.value;
        if (p2Item.type === "dodge" && g2.value >= g1.value) p2Dodged = true;
    }

    if (p1Dodged) { p2Dmg = 0; match.bonusPlayerIndex = 0; }
    if (p2Dodged) { p1Dmg = 0; match.bonusPlayerIndex = 1; }
    if (p1Dodged && p2Dodged) match.bonusPlayerIndex = -1;

    match.health[0] = Math.max(0, Math.min(MAX_HP, match.health[0] + p1Heal - p2Dmg));
    match.health[1] = Math.max(0, Math.min(MAX_HP, match.health[1] + p2Heal - p1Dmg));

    const firstActor =
        g1.value > g2.value ? 0 :
        g2.value > g1.value ? 1 : -1;

    broadcast({
        type: "turn_result",
        dice,
        health: match.health,
        p1: { slot: g1.slot, guess: g1.value, dmg: p1Dmg, heal: p1Heal, dodged: p1Dodged },
        p2: { slot: g2.slot, guess: g2.value, dmg: p2Dmg, heal: p2Heal, dodged: p2Dodged },
        firstActor,
        hasBonus: match.bonusPlayerIndex
    });

    match.animsFinished = [false, false];
    turnTimer = setTimeout(proceedAfterAnimation, ANIM_SAFETY_TIMEOUT);
}

function proceedAfterAnimation()
{
    if (turnTimer) clearTimeout(turnTimer);

    if (match.health[0] <= 0 || match.health[1] <= 0) {
        endRound();
        return;
    }

    if (match.bonusPlayerIndex !== -1) {
        match.status = "bonus_move";
        broadcast({ type: "bonus_start", playerIndex: match.bonusPlayerIndex });
        turnTimer = setTimeout(handleAFK, TURN_TIME_LIMIT);
        return;
    }

    nextTurn();
}

function endRound()
{
    match.status = "round_wait";
    broadcast({ type: "new_dice_round", health: match.health });
}

// --- SERVER CORE ---
wss.on("connection", (ws) => {

    ws.on("message", (data) => {
        const msg = safeJSON(data);
        if (!msg) return;

        // JOIN
        if (msg.type === "join") {
            if (players.length >= 2) return;

            const id = randomUUID();
            ws.playerId = id;
            players.push({ ws, playerId: id, equipments: msg.equipments || [] });

            sendToGM(ws, { type: "assign_id", playerId: id });

            if (players.length === 2) {
                match.status = "lobby_ready";
                match.playerReady = [false, false];
                match.playerIds = players.map(p => p.playerId);

                broadcast({ type: "lobby_ready" });
            }
        }

        // PLAYER READY
        if (msg.type === "player_ready" && match.status === "lobby_ready") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx === -1) return;

            match.playerReady[pIdx] = true;

            broadcast({
                type: "player_ready_update",
                playerIndex: pIdx
            });

            if (match.playerReady[0] && match.playerReady[1]) {
                startMatch(true);
            }
        }

        // GUESS
        if (msg.type === "guess") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx === -1) return;

            if (match.status === "playing") {
                if (match.guesses[pIdx][match.currentTurn - 1] !== undefined) return;
                match.guesses[pIdx][match.currentTurn - 1] = { value: msg.value, slot: msg.slot_index };
                checkTurnCompletion();
            }
        }

        // ANIMATION DONE
        if (msg.type === "anim_done") {
            const pIdx = match.playerIds.indexOf(ws.playerId);
            if (pIdx !== -1) {
                match.animsFinished[pIdx] = true;
                if (match.animsFinished[0] && match.animsFinished[1]) {
                    proceedAfterAnimation();
                }
            }
        }
    });

    ws.on("close", () => {
        players = [];
        match.status = "waiting";
        match.playerReady = [false, false];
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("Server Online");
});
