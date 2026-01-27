import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) =>
{
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Server alive");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) =>
{
    console.log("Client connected");

    ws.send("hello from railway");

    ws.on("message", (msg) =>
    {
        ws.send(msg.toString());
    });
});

server.listen(PORT, () =>
{
    console.log("Server running on port", PORT);
});
