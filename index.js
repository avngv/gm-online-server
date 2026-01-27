const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) =>
{
    res.writeHead(200);
    res.end("OK");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) =>
{
    console.log("Client connected");

    ws.send("hello from railway");

    ws.on("message", (msg) =>
    {
        console.log("Received:", msg.toString());
        ws.send("echo: " + msg);
    });

    ws.on("close", () =>
    {
        console.log("Client disconnected");
    });
});

server.listen(PORT, () =>
{
    console.log("Server running on port", PORT);
});
