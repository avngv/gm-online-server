// ================================
// GameMaker WebSocket Server
// Railway-compatible
// ================================

const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// ----------------
// OLD STATE (DO NOT CHANGE)
// ----------------
let nextPlayerId = 1;
let players = []; // { ws, id, equipments }

// ----------------
// NEW STATE (ADDED)
// ----------------
let playerReady = {}; // playerId -> boolean
let matchStarted = false;

// ----------------
// Utility
// ----------------
function sendToGM(ws, obj)
{
    const json = JSON.stringify(obj);
    ws.send(json);
}

function log(...args)
{
    console.log("[SERVER]", ...args);
}

// ----------------
// Connection
// ----------------
wss.on("connection", (ws) =>
{
    log("Client connected");

    // ---- OLD BEHAVIOR (UNCHANGED) ----
    const newId = nextPlayerId++;
    const clientEquips = []; // KEEP same logic as old code

    players.push({
        ws: ws,
        id: newId,
        equipments: clientEquips
    });

    playerReady[newId] = false;

    sendToGM(ws, {
        type: "assign_id",
        playerId: newId,
        equipments: clientEquips
    });

    log(`Assigned playerId=${newId}`);

    // ----------------
    // Message handling
    // ----------------
    ws.on("message", (data) =>
    {
        let msg;

        try
        {
            msg = JSON.parse(data);
        }
        catch (e)
        {
            log("Invalid JSON received");
            return;
        }

        if (!msg.type) return;

        log(`Received message from player ${newId}:`, msg.type);

        // ================================
        // NEW MESSAGE (ADDED ONLY)
        // ================================
        if (msg.type === "player_ready")
        {
            playerReady[newId] = true;
            log(`Player ${newId} is READY`);

            checkStartMatch();
            return;
        }

        // ================================
        // OLD MESSAGE TYPES PASS THROUGH
        // ================================
        // (no changes here)
    });

    // ----------------
    // Disconnect
    // ----------------
    ws.on("close", () =>
    {
        log(`Player ${newId} disconnected`);

        players = players.filter(p => p.id !== newId);
        delete playerReady[newId];
        matchStarted = false;
    });
});

// ----------------
// Match start logic (ADDED)
// ----------------
function checkStartMatch()
{
    if (matchStarted) return;
    if (players.length < 2) return;

    for (const p of players)
    {
        if (!playerReady[p.id]) return;
    }

    matchStarted = true;
    log("ALL PLAYERS READY — STARTING MATCH");

    for (const p of players)
    {
        sendToGM(p.ws, {
            type: "start_match"
        });
    }
}

// ----------------
// Startup log
// ----------------
log(`Server running on port ${PORT}`);
