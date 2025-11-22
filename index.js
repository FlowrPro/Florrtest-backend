import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import crypto from "crypto"; // built-in, no install needed

// --- Server setup ---
const app = express();
app.use(cors());
app.use(express.json()); // allow JSON body parsing
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- Accounts (Supabase REST API, hashed passwords) ---
const supabaseUrl = process.env.SUPABASE_URL;           // e.g. https://cskdnyqjbenwczpdggsb.supabase.co
const supabaseKey = process.env.SUPABASE_SECRET_KEY;    // your sb_secret_... key

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

// Register endpoint
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const hashed = hashPassword(password);

  const response = await fetch(`${supabaseUrl}/rest/v1/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
      "Prefer": "return=minimal"
    },
    body: JSON.stringify({ username, password: hashed })
  });

  if (!response.ok) {
    const error = await response.text();
    return res.status(400).json({ error });
  }

  res.json({ success: true });
});

// Login endpoint
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const hashed = hashPassword(password);

  // Look up user by username
  const response = await fetch(
    `${supabaseUrl}/rest/v1/users?username=eq.${username}`,
    {
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`
      }
    }
  );

  const data = await response.json();
  if (data.length === 0) return res.status(400).json({ error: "No such user" });
  if (data[0].password !== hashed) return res.status(400).json({ error: "Invalid password" });

  // Generate session token
  const token = Math.random().toString(36).substring(2);

  // Save token in Supabase
  const patchRes = await fetch(`${supabaseUrl}/rest/v1/users?username=eq.${username}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`
    },
    body: JSON.stringify({ sessiontoken: token })

  });

  if (!patchRes.ok) {
    const error = await patchRes.text();
    return res.status(500).json({ error: "Failed to save session token: " + error });
  }

  // Return token to client
  res.json({ success: true, token });
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

// Initial items
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
  width: 8000,
  height: 4000,
  centerX: 4000,
  centerY: 2000
};
seedItems(world.width, world.height);
// --- Persistence helper ---
async function savePlayerState(username, inventory, hotbar) {
  if (!username) return; // safety check
  try {
    await fetch(`${supabaseUrl}/rest/v1/users?username=eq.${username}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({ inventory, hotbar })
    });
  } catch (err) {
    console.error("Failed to save player state:", err);
  }
}

// --- Socket.IO handlers ---
io.on("connection", (socket) => {
  const id = socket.id;
  let authedUser = null;

  // ✅ Create the player object immediately so it's defined before auth
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

  // Authentication step
  socket.on("auth", async ({ token, username }) => {
    try {
      const response = await fetch(
        `${supabaseUrl}/rest/v1/users?username=eq.${username}`,
        {
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`
          }
        }
      );

      const data = await response.json();
if (data.length === 0) {
  socket.emit("auth_failed");
  socket.disconnect();
  return;
}

// ✅ Compare provided token with stored sessiontoken
if (!token || data[0].sessiontoken !== token) {
  socket.emit("auth_failed");
  socket.disconnect();
  return;
}

      authedUser = { username: data[0].username };

      // ✅ Now pendingPlayer exists, safe to restore
      pendingPlayer.inventory = data[0].inventory || new Array(24).fill(null);
      pendingPlayer.hotbar = data[0].hotbar || [];

      socket.emit("auth_success", { username: authedUser.username });
    } catch (err) {
      console.error("Auth error:", err);
      socket.emit("auth_failed");
      socket.disconnect();
    }
  });

  // Chat messages
  socket.on("chat_message", ({ text }) => {
    const p = players.get(id);
    const username = p?.username || "Anonymous";
    io.emit("chat_message", { username, text });
  });

  // Set username
  socket.on("set_username", ({ username }) => {
    if (!authedUser) {
      socket.emit("error", { message: "Not authenticated" });
      return;
    }

    pendingPlayer.username = username;

    // ✅ Only give starter petals if hotbar is empty (new player)
    if (!pendingPlayer.hotbar || pendingPlayer.hotbar.length === 0) {
      const starterColors = Array(10).fill("white");
      pendingPlayer.hotbar = starterColors.map(c => {
        const rarity = "unusual";
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
    }

    // ✅ Only initialize inventory if empty (new player)
    if (!pendingPlayer.inventory || pendingPlayer.inventory.length === 0) {
      pendingPlayer.inventory = new Array(24).fill(null);
    }

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

  // Pickup
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
        savePlayerState(p.username, p.inventory, p.hotbar);
      }
    }
  });

  // Equip
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
    savePlayerState(p.username, p.inventory, p.hotbar);
  });

  // Unequip
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
    savePlayerState(p.username, p.inventory, p.hotbar);
  });

  // Respawn
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
}); // <-- closes io.on("connection"
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

            // Apply damage
            other.health -= item.damage;
            if (other.health <= 0) {
              other.health = 0;
              broadcastPlayerUpdate(other);
              io.to(other.id).emit("player_dead");
            } else {
              broadcastPlayerUpdate(other);
            }

            // Petal durability check
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
