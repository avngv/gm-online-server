import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

const wss = new WebSocketServer({ port: PORT });

console.log("Server running on port", PORT);

// simple 1v1 rooms
let players = [];

wss.on("connection", (ws) =>
{
    console.log("Player connected");

    players.push(ws);

    ws.send(JSON.stringify({
        type: "connected",
        id: players.length
    }));

    ws.on("message", (data) =>
    {
        let msg = JSON.parse(data);

        // broadcast to opponent
        players.forEach(p =>
        {
            if (p !== ws && p.readyState === 1)
                p.send(JSON.stringify(msg));
        });
    });

    ws.on("close", () =>
    {
        console.log("Player disconnected");
        players = players.filter(p => p !== ws);
    });
});