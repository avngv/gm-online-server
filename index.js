const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer((req, res) =>
{
    res.writeHead(200);
    res.end("WebSocket server running");
});

// Attach websocket
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

// Start server
server.listen(PORT, () =>
{
    console.log("Server running on port", PORT);
});
