import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";

// --- Server setup ---
const app = express();
app.use(cors());
app.use(express.json()); // allow JSON body parsing
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- Accounts (no-install: plain JSON, plain passwords) ---
let users = [];
try {
  users = JSON.parse(fs.readFileSync("users.json", "utf8"));
} catch {
  users = [];
}
function saveUsers() {
  fs.writeFileSync("users.json", JSON.stringify(users, null, 2));
}
function register(username, password) {
  if (!username || !password) throw new Error("Username and password required");
  if (users.find(u => u.username === username)) {
    throw new Error("User already exists");
  }
  const user = { username, password, sessionToken: null, createdAt: Date.now() };
  users.push(user);
  saveUsers();
  return { success: true };
}
function login(username, password) {
  const user = users.find(u => u.username === username);
  if (!user) throw new Error("No such user");
  if (user.password !== password) throw new Error("Invalid password");
  const token = Math.random().toString(36).substring(2);
  user.sessionToken = token;
  saveUsers();
  return { success: true, token };
}

// REST endpoints
app.post("/register", (req, res) => {
  try {
    const result = register(req.body.username, req.body.password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/login", (req, res) => {
  try {
    const result = login(req.body.username, req.body.password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- World state (in-memory) ---
const players = new Map(); // socketId -> player object
const items = new Map();   // itemId -> item

// Rarity multipliers
const rarityMultipliers = {
  common: 1,
  unusual: 3,
  rare: 9,
  epic: 27,
  legendary: 81,
  mythic: 243,
  ultra: 729
};

// Helpers
function spawnItem(x, y, color = "cyan", rarity = "common") {
  const id = `item_${Math.random().toString(36).slice(2, 9)}`;
  const radius = 8;
  const name = "Petal";
  const mult = rarityMultipliers[rarity] || 1;

  items.set(id, { 
    id, x, y, radius, color, name,
    damage: 5 * mult,
    health: 15 * mult,
    maxHealth: 15 * mult,
    description: `Dropped ${rarity} petal.`,
    reload: 2000,
    reloadUntil: 0,
    rarity
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
  width: 8000,   // much wider
  height: 4000,  // much taller
  centerX: 4000,
  centerY: 2000
};
seedItems(world.width, world.height);

// --- Socket.IO handlers ---
io.on("connection", (socket) => {
  const id = socket.id;
  let authedUser = null;

  // Authentication step
  socket.on("auth", ({ token }) => {
    const user = users.find(u => u.sessionToken === token);
    if (!user) {
      socket.emit("auth_failed");
      socket.disconnect();
      return;
    }
    authedUser = user;
    socket.emit("auth_success", { username: user.username });
  });

  // Chat messages (server enforces username)
  socket.on("chat_message", ({ text }) => {
    const p = players.get(id);
    const username = p?.username || "Anonymous";
    io.emit("chat_message", { username, text });
  });

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

  // Set username → spawn player (only if authenticated)
  socket.on("set_username", ({ username }) => {
    if (!authedUser) {
      socket.emit("error", { message: "Not authenticated" });
      return;
    }

    pendingPlayer.username = authedUser.username;

    // Give starter petals now
    const starterColors = Array(10).fill("white");
    pendingPlayer.hotbar = starterColors.map(c => {
      const rarity = "unusual"; // change to "ultra" if you want ultra basics
      const mult = rarityMultipliers[rarity];
      return {
        name: "Petal",
        color: c,
        damage: 10 * mult,
        health: 25 * mult,
        maxHealth: 25 * mult,
        description: `${rarity} starter petal.`,
        reload: 2000,
        reloadUntil: 0,
        rarity
      };
    });

    players.set(id, pendingPlayer);

    socket.emit("world_snapshot", {
      world,
      self: pendingPlayer,
      players: Array.from(players.values()).filter(p => p.id !== id),
      items: Array.from(items.values())
    });

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
    if (p.health <= 0) return;

    p.x += dx * p.speed;
    p.y += dy * p.speed;
    p.x = Math.max(p.radius, Math.min(world.width - p.radius, p.x));
    p.y = Math.max(p.radius, Math.min(world.height - p.radius, p.y));
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
        p.inventory[emptyIdx] = { ...it };
        items.delete(itemId);
        socket.emit("inventory_update", p.inventory);
        broadcastItems();
      }
    }
  });

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

  socket.on("disconnect", () => {
    players.delete(id);
    socket.broadcast.emit("player_leave", { id });
  });
});

// --- Continuous orbit updates + combat ---
setInterval(() => {
  const now = Date.now();

  players.forEach(p => {
    if (p.health <= 0) return;
    p.orbitAngle += p.orbitSpeed;

    players.forEach(other => {
      if (other.id === p.id) return;
      if (other.health <= 0) return;

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

            // Use rarity-scaled damage
            other.health -= item.damage;
            if (other.health <= 0) {
              other.health = 0;
              broadcastPlayerUpdate(other);
              io.to(other.id).emit("player_dead");
            } else {
              broadcastPlayerUpdate(other);
            }

            // Petal durability check using rarity-scaled health
            if (item.damage >= item.health) {
              item.reloadUntil = now + item.reload;
              item.health = item.maxHealth; // reset after reload
            } else {
              item.health -= item.damage;
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
   

