const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const server = http.createServer();

const wss = new WebSocket.Server({
    server,
    handleProtocols: (protocols) =>
    {
        if (protocols.includes("binary")) return "binary";
        return false;
    }
});

let players = [];

function broadcast(obj)
{
    const msg = JSON.stringify(obj);
    players.forEach(p =>
    {
        if (p.readyState === WebSocket.OPEN)
            p.send(msg);
    });
}

wss.on("connection", (ws) =>
{
    console.log("Player connected");

    if (players.length >= 2)
    {
        ws.send(JSON.stringify({
            type: "full"
        }));
        ws.close();
        return;
    }

    players.push(ws);

    // tell player to wait
    ws.send(JSON.stringify({
        type: "wait",
        count: players.length
    }));

    // when 2 players connected
    if (players.length === 2)
    {
        console.log("Match ready");

        players[0].send(JSON.stringify({
            type: "start",
            playerIndex: 0
        }));

        players[1].send(JSON.stringify({
            type: "start",
            playerIndex: 1
        }));
    }

    ws.on("message", (data) =>
    {
        let msg;

        try {
            msg = JSON.parse(data.toString());
        }
        catch {
            return;
        }

        console.log("CLIENT:", msg);
    });

    ws.on("close", () =>
    {
        console.log("Player disconnected");

        players = players.filter(p => p !== ws);

        broadcast({
            type: "opponent_left"
        });
    });
});

server.listen(PORT, () =>
{
    console.log("Server running on port", PORT);
});
