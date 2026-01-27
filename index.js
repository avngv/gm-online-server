const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

// Create plain HTTP server (required for WebSocket)
const server = http.createServer();

const wss = new WebSocket.Server({
    server,
    handleProtocols: (protocols) => {
        if (protocols.includes("binary")) return "binary";
        return false;
    }
});

// Keep track of connected players
let players = [];

// Safely parse JSON from GameMaker
function safeJSON(data) {
    try {
        if (typeof data === "string") return JSON.parse(data);
        // binary frame (ArrayBuffer / Buffer / Uint8Array)
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

wss.on("connection", (ws) => {
    console.log("Player connected");

    // Limit to 2 players per match
    if (players.length >= 2) {
        ws.send(JSON.stringify({ type: "full" }));
        ws.close();
        return;
    }

    players.push(ws);

    // Tell player to wait
    ws.send(JSON.stringify({ type: "wait", count: players.length }));

    // If 2 players connected, start match
    if (players.length === 2) {
        console.log("Match ready");

        players[0].send(JSON.stringify({ type: "start", playerIndex: 0 }));
        players[1].send(JSON.stringify({ type: "start", playerIndex: 1 }));
    }

    // Handle incoming messages from GameMaker clients
    ws.on("message", (data) => {
        const msg = safeJSON(data);
        if (!msg) return;

        console.log("CLIENT:", msg);

        // Example: relay message to other player
        players.forEach(p => {
            if (p !== ws && p.readyState === WebSocket.OPEN) {
                p.send(JSON.stringify({ type: "sync", data: msg }));
            }
        });
    });

    ws.on("close", () => {
        console.log("Player disconnected");

        // Remove disconnected player
        players = players.filter(p => p !== ws);

        // Notify remaining player
        broadcast({ type: "opponent_left" });
    });
});

// Start server on Railway port
server.listen(PORT, () => {
    console.log("Server running on port", PORT);
});
