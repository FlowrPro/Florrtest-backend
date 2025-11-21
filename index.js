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
const players = new Map(); // socketId -> player object
const items = new Map();   // itemId -> item

// Helpers
function spawnItem(x, y, color = "cyan") {
  const id = `item_${Math.random().toString(36).slice(2, 9)}`;
  const radius = 8;
  const name = "Petal";
  items.set(id, { 
    id, x, y, radius, color, name,
    damage: 5, 
    health: 15, 
    maxHealth: 15,
    description: "Dropped petal with weaker stats.",
    reload: 2000,
    reloadUntil: 0
  });
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
    hotbar: p.hotbar,
    username: p.username,
    orbitDist: p.orbitDist,
    health: p.health,
    invincibleUntil: p.invincibleUntil || 0
  });
}

// --- Configurable world ---
const world = {
  width: 1600,
  height: 900,
  centerX: 800,
  centerY: 450,
  mapRadius: (Math.min(1600, 900) / 2 - 60) * 3
};
seedItems(world.width, world.height);

// --- Socket.IO handlers ---
io.on("connection", (socket) => {
  const id = socket.id;

  // Pending player (not yet spawned in world)
  const pendingPlayer = {
    id,
    x: world.centerX,
    y: world.centerY,
    radius: 20,
    speed: 3,
    orbitAngle: 0,
    orbitSpeed: 0.08,
    hotbar: [],
    inventory: new Array(24).fill(null),
    username: null,
    orbitDist: 56,
    health: 100,
    invincibleUntil: 0
  };

  // Send world snapshot but no self yet
  socket.emit("world_snapshot", {
    world,
    self: null,
    players: Array.from(players.values()),
    items: Array.from(items.values())
  });

  // Set username → spawn player
  socket.on("set_username", ({ username }) => {
    pendingPlayer.username = username;

    // Give starter petals now
    const starterColors = Array(10).fill("white");
    pendingPlayer.hotbar = starterColors.map(c => ({
      name: "Petal",
      color: c,
      damage: 10,
      health: 25,
      maxHealth: 25,
      description: "Basic starter petal.",
      reload: 2000,
      reloadUntil: 0
    }));

    players.set(id, pendingPlayer);

    // Send updated snapshot with self
    socket.emit("world_snapshot", {
      world,
      self: pendingPlayer,
      players: Array.from(players.values()).filter(p => p.id !== id),
      items: Array.from(items.values())
    });

    // Notify others
    socket.broadcast.emit("player_join", {
      id: pendingPlayer.id,
      x: pendingPlayer.x,
      y: pendingPlayer.y,
      radius: pendingPlayer.radius,
      hotbar: pendingPlayer.hotbar,
      username: pendingPlayer.username,
      orbitDist: pendingPlayer.orbitDist,
      health: pendingPlayer.health,
      invincibleUntil: pendingPlayer.invincibleUntil
    });
  });

  // Movement
  socket.on("move", ({ dx, dy }) => {
    const p = players.get(id);
    if (!p) return;
    if (p.health <= 0) return; // dead players can't move

    p.x += dx * p.speed;
    p.y += dy * p.speed;
    const d = distance(p.x, p.y, world.centerX, world.centerY);
    if (d > world.mapRadius - p.radius) {
      const angle = Math.atan2(p.y - world.centerY, p.x - world.centerX);
      p.x = world.centerX + (world.mapRadius - p.radius) * Math.cos(angle);
      p.y = world.centerY + (world.mapRadius - p.radius) * Math.sin(angle);
    }
    broadcastPlayerUpdate(p);
  });

  // Orbit control
  socket.on("orbit_control", ({ orbitDist }) => {
    const p = players.get(id);
    if (!p) return;
    p.orbitDist = orbitDist;
    broadcastPlayerUpdate(p);
  });

  // Pickup request
  socket.on("pickup_request", ({ itemId }) => {
    const p = players.get(id);
    const it = items.get(itemId);
    if (!p || !it) return;

    const d = distance(p.x, p.y, it.x, it.y);
    if (d < p.radius + it.radius) {
      const emptyIdx = p.inventory.findIndex(s => s === null);
      if (emptyIdx !== -1) {
        p.inventory[emptyIdx] = {
          name: it.name,
          color: it.color,
          damage: it.damage,
          health: it.health,
          maxHealth: it.maxHealth,
          description: it.description,
          reload: it.reload,
          reloadUntil: it.reloadUntil
        };
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

  // Respawn request
  socket.on("respawn_request", () => {
    const p = players.get(id);
    if (!p) return;
    p.x = world.centerX;
    p.y = world.centerY;
    p.health = 100;
    p.invincibleUntil = Date.now() + 2000;
    broadcastPlayerUpdate(p);
    socket.emit("respawn_success", p);
  });

  // Disconnect
  socket.on("disconnect", () => {
    players.delete(id);
    socket.broadcast.emit("player_leave", { id });
  });
});

// --- Continuous orbit updates + combat ---
setInterval(() => {
  const now = Date.now();

  players.forEach(p => {
    if (p.health <= 0) return; // dead players inert
    p.orbitAngle += p.orbitSpeed;

    players.forEach(other => {
      if (other.id === p.id) return;
      if (other.health <= 0) return; // skip dead targets

      const equipped = p.hotbar.filter(i => i);
      if (equipped.length > 0) {
        const angleStep = (2 * Math.PI) / equipped.length;
        equipped.forEach((item, idx) => {
          if (item.reloadUntil && now < item.reloadUntil) return;

          const angle = p.orbitAngle + idx * angleStep;
          const petalX = p.x + (p.orbitDist || 56) * Math.cos(angle);
          const petalY = p.y + (p.orbitDist || 56) * Math.sin(angle);

          const dist = distance(petalX, petalY, other.x, other.y);
          if (dist < other.radius + 8) {
            if (other.invincibleUntil && now < other.invincibleUntil) return;

            other.health -= 20;
            if (other.health <= 0) {
              other.health = 0;
              broadcastPlayerUpdate(other);
               io.to(other.id).emit("player_dead");
            } else {
              broadcastPlayerUpdate(other);
            }

            // Petal health check (only if hitting a living body)
            if (20 >= item.health) {
              item.reloadUntil = now + item.reload;
              item.health = item.maxHealth; // will be full when it reappears after reload
            } else {
              item.health -= 20;
            }
          }
        });
      }
    });

    broadcastPlayerUpdate(p);
  });
}, 50); // update ~20 times per second

// Health check
app.get("/", (_req, res) => res.send("Florr backend OK"));

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});



