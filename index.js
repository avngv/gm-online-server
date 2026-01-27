import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) =>
{
    res.writeHead(200);
    res.end("OK");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) =>
{
    wss.handleUpgrade(request, socket, head, (ws) =>
    {
        wss.emit("connection", ws, request);
    });
});

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
