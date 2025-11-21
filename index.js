import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

// --- Server setup ---
const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- World state (in-memory) ---
const players = new Map(); // socketId -> { id, x, y, radius, speed, orbitAngle, orbitSpeed, hotbar:[], inventory:[] }
const items = new Map();   // itemId -> { id, x, y, radius, color, name }

// Helpers
function spawnItem(x, y, color = "cyan") {
  const id = `item_${Math.random().toString(36).slice(2, 9)}`;
  const radius = 8;
  const name = "Petal";
  items.set(id, { id, x, y, radius, color, name });
  return id;
}
function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

// Initial items (you can randomize later)
function seedItems(worldW, worldH) {
  items.clear();
}

// Broadcast helpers
function broadcastItems() {
  io.emit("items_update", Array.from(items.values()));
}
function broadcastPlayerUpdate(p) {
  io.emit("player_update", {
    id: p.id,
    x: p.x,
    y: p.y,
    radius: p.radius,
    orbitAngle: p.orbitAngle,
    orbitSpeed: p.orbitSpeed,
    hotbar: p.hotbar
  });
}

// --- Configurable world ---
const world = {
  width: 1600,
  height: 900,
  centerX: 800,
  centerY: 450,
  mapRadius: Math.min(1600, 900) / 2 - 60
};
seedItems(world.width, world.height);

// --- Socket.IO handlers ---
io.on("connection", (socket) => {
  const id = socket.id;

  // Create player
  // Pre-fill hotbar with 10 petals
const starterColors = [
  "cyan", "red", "blue", "purple", "orange",
  "green", "yellow", "pink", "lime", "magenta"
];

const hotbarItems = starterColors.map(c => ({ name: "Petal", color: c }));

const player = {
  id,
  x: world.centerX,
  y: world.centerY,
  radius: 20,
  speed: 3,
  orbitAngle: 0,
  orbitSpeed: 0.02,
  hotbar: hotbarItems,                 // now full of 10 items
  inventory: new Array(24).fill(null)
};
  players.set(id, player);

  // Send world snapshot to the new player
  socket.emit("world_snapshot", {
    world,
    self: player,
    players: Array.from(players.values()).filter(p => p.id !== id),
    items: Array.from(items.values())
  });

  // Notify others
  socket.broadcast.emit("player_join", {
    id: player.id,
    x: player.x,
    y: player.y,
    radius: player.radius,
    hotbar: player.hotbar
  });

  // Movement
  socket.on("move", ({ dx, dy }) => {
    const p = players.get(id);
    if (!p) return;
    p.x += dx * p.speed;
    p.y += dy * p.speed;
    // Keep inside circular map
    const d = distance(p.x, p.y, world.centerX, world.centerY);
    if (d > world.mapRadius - p.radius) {
      const angle = Math.atan2(p.y - world.centerY, p.x - world.centerX);
      p.x = world.centerX + (world.mapRadius - p.radius) * Math.cos(angle);
      p.y = world.centerY + (world.mapRadius - p.radius) * Math.sin(angle);
    }
    broadcastPlayerUpdate(p);
  });

  // Orbit control (optional future use)
  socket.on("orbit_control", ({ state }) => {
    const p = players.get(id);
    if (!p) return;
    // Client decides visual distance; server only stores angle progression
  });

  // Pickup request
  socket.on("pickup_request", ({ itemId }) => {
    const p = players.get(id);
    const it = items.get(itemId);
    if (!p || !it) return;

    // Validate proximity
    const d = distance(p.x, p.y, it.x, it.y);
    if (d < p.radius + it.radius) {
      // Place into first empty inventory slot
      const emptyIdx = p.inventory.findIndex(s => s === null);
      if (emptyIdx !== -1) {
        p.inventory[emptyIdx] = { name: it.name, color: it.color };
        items.delete(itemId);
        socket.emit("inventory_update", p.inventory);
        broadcastItems();
      }
    }
  });

  // Equip from inventory to hotbar
  socket.on("equip_request", ({ invIndex, hotbarIndex }) => {
    const p = players.get(id);
    if (!p) return;
    const item = p.inventory[invIndex];
    if (!item) return;
    p.hotbar[hotbarIndex] = item;
    p.inventory[invIndex] = null;
    socket.emit("inventory_update", p.inventory);
    socket.emit("hotbar_update", p.hotbar);
    broadcastPlayerUpdate(p);
  });

  // Unequip from hotbar to inventory
  socket.on("unequip_request", ({ hotbarIndex }) => {
    const p = players.get(id);
    if (!p) return;
    const item = p.hotbar[hotbarIndex];
    if (!item) return;
    const emptyIdx = p.inventory.findIndex(s => s === null);
    if (emptyIdx === -1) return;
    p.inventory[emptyIdx] = item;
    p.hotbar[hotbarIndex] = null;
    socket.emit("inventory_update", p.inventory);
    socket.emit("hotbar_update", p.hotbar);
    broadcastPlayerUpdate(p);
  });

  // Disconnect
  socket.on("disconnect", () => {
    players.delete(id);
    socket.broadcast.emit("player_leave", { id });
  });
});

// --- Continuous orbit updates ---
setInterval(() => {
  players.forEach(p => {
    p.orbitAngle += p.orbitSpeed;
    broadcastPlayerUpdate(p);
  });
}, 50); // update ~20 times per second

// Health check
app.get("/", (_req, res) => res.send("Florr backend OK"));

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
