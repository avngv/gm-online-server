import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

// create http server
const server = http.createServer((req, res) =>
{
    res.writeHead(200);
    res.end("OK");
});

// attach websocket to http server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) =>
{
    console.log("Player connected");

    ws.send("hello from railway");

    ws.on("message", (msg) =>
    {
        ws.send(msg.toString());
    });
});

// listen
server.listen(PORT, () =>
{
    console.log("Server running on port", PORT);
});
