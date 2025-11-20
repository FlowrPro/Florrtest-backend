const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const players = {};

io.on("connection", socket => {
  console.log("Player connected:", socket.id);

  players[socket.id] = {
    x: 0,
    y: 0,
    inventory: []
  };

  socket.emit("init", players[socket.id]);

  socket.on("move", ({ x, y }) => {
    if (players[socket.id]) {
      players[socket.id].x = x;
      players[socket.id].y = y;
      socket.broadcast.emit("playerMoved", { id: socket.id, x, y });
    }
  });

  socket.on("pickupItem", item => {
    if (players[socket.id]) {
      players[socket.id].inventory.push(item);
      socket.emit("inventoryUpdate", players[socket.id].inventory);
    }
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    delete players[socket.id];
    socket.broadcast.emit("playerDisconnected", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
