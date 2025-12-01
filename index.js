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
  cors: {
    origin: "*", // for testing; replace with "https://flowrtest.netlify.app" in production
    methods: ["GET", "POST"]
  }
});

// --- Accounts (Supabase REST API, hashed passwords) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

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

  const token = crypto.randomBytes(32).toString("hex");

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

  res.json({ success: true, token });
});

// --- World state (in-memory) ---
const players = new Map();
const items = new Map();

const rarityMultipliers = {
  common: 1,
  unusual: 3,
  rare: 9,
  epic: 27,
  legendary: 81,
  mythic: 243,
  ultra: 729
};

// --- Admin username ---
const ADMIN_USERNAME = "CharmedZ";

// --- Bone Petal factory ---
function createBonePetal(rarity = "common") {
  const mult = rarityMultipliers[rarity] || 1;
  return {
    name: "Bone",
    color: "gray",
    image: "/assets/bone.png",
    damage: 30 * mult,
    health: 75 * mult,
    maxHealth: 75 * mult,
    description: `${rarity} Bone petal. Grants +50% max health per Bone equipped.`,
    reload: 3000,
    reloadUntil: 0,
    rarity
  };
}

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

function seedItems(worldW, worldH) {
  items.clear();
}

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
    maxHealth: p.maxHealth,
    invincibleUntil: p.invincibleUntil || 0
  });
}

const world = {
  width: 8000,
  height: 4000,
  centerX: 4000,
  centerY: 2000
};
seedItems(world.width, world.height);

async function savePlayerState(username, inventory, hotbar) {
  if (!username) return;
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

// Track active players globally
const activePlayers = new Map();

/* ===========================
   MOBS: storage, zones, spawn
   =========================== */
const mobs = new Map();
const rarityZones = ["common", "unusual", "rare", "epic", "legendary", "mythic", "ultra"];
const zoneWidth = world.width / rarityZones.length;
const maxMobsPerZone = 15;

function broadcastMobs() {
  io.emit("mobs_update", Array.from(mobs.values()));
}
function countMobsInZone(zoneIndex) {
  let count = 0;
  for (const m of mobs.values()) {
    const zi = Math.floor(m.x / zoneWidth);
    if (zi === zoneIndex) count++;
  }
  return count;
}
function spawnMob(x, y) {
  x = Math.max(0, Math.min(world.width, x));
  y = Math.max(0, Math.min(world.height, y));

  const zoneIndex = Math.max(0, Math.min(rarityZones.length - 1, Math.floor(x / zoneWidth)));
  const rarity = rarityZones[zoneIndex];
  const mult = rarityMultipliers[rarity];
  const id = `mob_${Math.random().toString(36).slice(2, 9)}`;

  const baseDamage = 25;
  const baseHealth = 100;
  const baseSize = 40;

  const radius = baseSize * (1 + 1.0 * zoneIndex);

  mobs.set(id, {
    id,
    x,
    y,
    radius,
    damage: baseDamage * mult,
    health: baseHealth * mult,
    maxHealth: baseHealth * mult,
    rarity,
    color: "purple",
    targetId: null,
    type: "beetle" // mark type for drops
  });

  return id;
}

// --- Socket.IO handlers ---
function createPendingPlayer(id, socket, username = null) {
  const spawnX = 20;
  const spawnY = world.height / 2;

  return {
    id,
    socket,   // ✅ keep socket reference here
    x: spawnX,
    y: spawnY,
    radius: 20,
    speed: 3,
    orbitAngle: 0,
    orbitSpeed: 0.08,
    hotbar: [],
    inventory: new Array(24).fill(null),
    username,
    orbitDist: 56,
    health: 100,
    maxHealth: 100,
    invincibleUntil: 0,
    spawnX,
    spawnY
  };
}

io.on("connection", (socket) => {
  const id = socket.id;
  let authedUser = null;

  const pendingPlayer = createPendingPlayer(id, socket);

    // --- Authentication ---
  socket.on("auth", async ({ token, username }) => {
    try {
      const response = await fetch(
        `${supabaseUrl}/rest/v1/users?username=eq.${encodeURIComponent(username)}`,
        { headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` } }
      );
      const data = await response.json();
      if (data.length === 0) return socket.emit("auth_failed");
      const storedToken = data[0].sessiontoken;
      if (!token || storedToken !== token) return socket.emit("auth_failed");
      if (activePlayers.has(username)) {
        socket.emit("auth_failed", { reason: "already_logged_in" });
        return socket.disconnect();
      }
      activePlayers.set(username, socket.id);
      authedUser = { username: data[0].username };
      pendingPlayer.inventory = data[0].inventory || new Array(24).fill(null);
      pendingPlayer.hotbar = data[0].hotbar || [];
      socket.emit("auth_success", { username: authedUser.username });
    } catch (err) {
      console.error("Auth error:", err);
      socket.emit("auth_failed");
    }
  });

 // --- Chat ---
socket.on("chat_message", ({ text }) => {
  const p = players.get(id);
  const username = p?.username || "Anonymous";

  io.emit("chat_message", {
    username,
    text,
    isAdmin: p?.isAdmin || false   // ✅ flag admin so frontend can style
  });
});

  // --- Set username ---
  socket.on("set_username", ({ username }) => {
    if (!authedUser) {
      socket.emit("error", { message: "Not authenticated" });
      return;
    }

    pendingPlayer.username = username;

    // ✅ Admin buffs for CharmedZ
    if (username === ADMIN_USERNAME) {
      pendingPlayer.speed *= 3;
      pendingPlayer.isAdmin = true;

      // Give 20 ultra Bones
      for (let i = 0; i < 20; i++) {
        const existing = pendingPlayer.inventory.find(slot =>
          slot && slot.item.name === "Bone" && slot.item.rarity === "ultra"
        );
        if (existing) {
          existing.count += 1;
        } else {
          const emptyIdx = pendingPlayer.inventory.findIndex(s => s === null);
          if (emptyIdx !== -1) {
            pendingPlayer.inventory[emptyIdx] = { item: createBonePetal("ultra"), count: 1 };
          }
        }
      }
    }

    if (!pendingPlayer.hotbar || pendingPlayer.hotbar.length === 0) {
      const starterColors = Array(9).fill("white");
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

      // ✅ Add one Bone Petal starter
      pendingPlayer.hotbar.push(createBonePetal("common"));
    }

    if (!pendingPlayer.inventory || pendingPlayer.inventory.length === 0) {
      pendingPlayer.inventory = new Array(24).fill(null);
    }

    players.set(id, pendingPlayer);

    socket.emit("world_snapshot", {
      world,
      self: pendingPlayer,
      players: Array.from(players.values()).filter(p => p.id !== id),
      items: Array.from(items.values()),
      mobs: Array.from(mobs.values())
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
    if (!p || p.health <= 0) return;
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
      const existing = p.inventory.find(slot =>
        slot && slot.item.name === it.name && slot.item.rarity === it.rarity
      );

      if (existing) {
        existing.count += 1;
      } else {
        const emptyIdx = p.inventory.findIndex(s => s === null);
        if (emptyIdx !== -1) {
          p.inventory[emptyIdx] = { item: { ...it }, count: 1 };
        }
      }
      items.delete(itemId);
      socket.emit("inventory_update", p.inventory);
      broadcastItems();
      savePlayerState(p.username, p.inventory, p.hotbar);
    }
  });

  // Equip
  socket.on("equip_request", ({ invIndex, hotbarIndex }) => {
    const p = players.get(id);
    if (!p) return;
    const slot = p.inventory[invIndex];
    if (!slot) return;

    if (slot.count > 1) {
      slot.count -= 1;
      p.hotbar[hotbarIndex] = { ...slot.item };
    } else {
      p.hotbar[hotbarIndex] = slot.item;
      p.inventory[invIndex] = null;
    }
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

    // Try to stack into existing slot
    const existing = p.inventory.find(slot =>
      slot && slot.item.name === item.name && slot.item.rarity === item.rarity
    );

    if (existing) {
      existing.count += 1;
    } else {
      const emptyIdx = p.inventory.findIndex(s => s === null);
      if (emptyIdx === -1) return;
      p.inventory[emptyIdx] = { item: { ...item }, count: 1 };
    }

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
    p.x = p.spawnX;
    p.y = p.spawnY;
    p.health = p.maxHealth;  // reset health to max
    p.invincibleUntil = Date.now() + 2000;
    broadcastPlayerUpdate(p);
    socket.emit("respawn_success", p);
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (authedUser && activePlayers.get(authedUser.username) === socket.id) {
      activePlayers.delete(authedUser.username);
      savePlayerState(authedUser.username, pendingPlayer.inventory, pendingPlayer.hotbar);
    }
    players.delete(id);
    socket.broadcast.emit("player_leave", { id });
  });
}); // closes io.on("connection")

// --- Continuous updates: orbit combat + mob AI ---
setInterval(() => {
  const now = Date.now();

  // Player orbit combat (vs players and mobs)
  players.forEach(p => {
    if (p.health <= 0) return;

    // Bone bonus
    const boneCount = p.hotbar.filter(i => i && i.name === "Bone").length;
    const baseMaxHealth = 100;
    p.maxHealth = baseMaxHealth + baseMaxHealth * 0.5 * boneCount;
    if (p.health > p.maxHealth) p.health = p.maxHealth;

    p.orbitAngle += p.orbitSpeed;

    const equipped = p.hotbar.filter(i => i);
    if (equipped.length > 0) {
      const angleStep = (2 * Math.PI) / equipped.length;
      equipped.forEach((item, idx) => {
        if (item.reloadUntil && now < item.reloadUntil) return;
        const angle = p.orbitAngle + idx * angleStep;
        const petalX = p.x + (p.orbitDist || 56) * Math.cos(angle);
        const petalY = p.y + (p.orbitDist || 56) * Math.sin(angle);

        // Admin scaling
        const dmg = p.isAdmin ? item.damage * 2 : item.damage;
        const hpLoss = p.isAdmin ? item.damage * 2 : item.damage;

        // Damage other players
        players.forEach(other => {
          if (other.id === p.id || other.health <= 0) return;
          const distToOther = distance(petalX, petalY, other.x, other.y);
          if (distToOther < other.radius + (item.radius || 8)) {
            if (other.invincibleUntil && now < other.invincibleUntil) return;
            other.health -= dmg;
            if (other.health <= 0) {
              other.health = 0;
              broadcastPlayerUpdate(other);
              io.to(other.id).emit("player_dead");
            } else {
              broadcastPlayerUpdate(other);
            }
            item.health -= hpLoss;
            if (item.health <= 0) {
              item.reloadUntil = now + item.reload;
              item.health = item.maxHealth;
            }
          }
        });

        // Damage mobs
        mobs.forEach(m => {
          if (m.health <= 0) return;
          const distToMob = distance(petalX, petalY, m.x, m.y);
          if (distToMob < m.radius + (item.radius || 8)) {
            m.health -= dmg;

            // Track who damaged this mob
            if (!m.damageDealers) m.damageDealers = new Set();
            m.damageDealers.add(p.id);

            // Petal takes damage
            item.health -= p.isAdmin ? m.damage * 2 : m.damage;
            if (item.health <= 0) {
              item.reloadUntil = now + item.reload;
              item.health = item.maxHealth;
            }

            if (m.health <= 0) {
              m.health = 0;
              mobs.delete(m.id);
              io.emit("mob_dead", { id: m.id });

              // Drop a Bone Petal when a beetle mob dies
              if (m.type === "beetle") {
                const bone = createBonePetal(m.rarity);
                const itemId = `item_${Math.random().toString(36).slice(2, 9)}`;
                const drop = {
                  id: itemId,
                  x: m.x,
                  y: m.y,
                  radius: 16,
                  ...bone
                };

                items.set(itemId, drop);

                m.damageDealers.forEach(playerId => {
                  const dmgPlayer = players.get(playerId);
                  if (dmgPlayer && dmgPlayer.socket) {
                    dmgPlayer.socket.emit("item_spawn", drop);
                  }
                });
              }
            }
          }
        }); // closes mobs.forEach
      });   // closes equipped.forEach
    }       // closes if (equipped.length > 0)

    broadcastPlayerUpdate(p);
  });       // closes players.forEach

  setInterval(() => {
  const now = Date.now();

  // --- Player orbit combat (vs players and mobs) ---
  players.forEach(p => {
    if (p.health <= 0) return;

    // Bone bonus
    const boneCount = p.hotbar.filter(i => i && i.name === "Bone").length;
    const baseMaxHealth = 100;
    p.maxHealth = baseMaxHealth + baseMaxHealth * 0.5 * boneCount;
    if (p.health > p.maxHealth) p.health = p.maxHealth;

    p.orbitAngle += p.orbitSpeed;

    const equipped = p.hotbar.filter(i => i);
    if (equipped.length > 0) {
      const angleStep = (2 * Math.PI) / equipped.length;
      equipped.forEach((item, idx) => {
        if (item.reloadUntil && now < item.reloadUntil) return;
        const angle = p.orbitAngle + idx * angleStep;
        const petalX = p.x + (p.orbitDist || 56) * Math.cos(angle);
        const petalY = p.y + (p.orbitDist || 56) * Math.sin(angle);

        // ✅ Damage other players (your existing code)

        // ✅ Damage mobs (this is where the bone drop block goes)
        mobs.forEach(m => {
          if (m.health <= 0) return;
          const distToMob = distance(petalX, petalY, m.x, m.y);
          if (distToMob < m.radius + (item.radius || 8)) {
            m.health -= dmg;
            m.damageDealers.add(p.id);

            item.health -= p.isAdmin ? m.damage * 2 : m.damage;
            if (item.health <= 0) {
              item.reloadUntil = now + item.reload;
              item.health = item.maxHealth;
            }

            if (m.health <= 0) {
              m.health = 0;
              mobs.delete(m.id);
              io.emit("mob_dead", { id: m.id });

              // ✅ Bone drop logic
              if (m.type === "beetle") {
                const bone = createBonePetal(m.rarity);
                const itemId = `item_${Math.random().toString(36).slice(2, 9)}`;
                const drop = { id: itemId, x: m.x, y: m.y, radius: 16, ...bone };
                items.set(itemId, drop);

                m.damageDealers.forEach(playerId => {
                  const dmgPlayer = players.get(playerId);
                  if (dmgPlayer && dmgPlayer.socket) {
                    dmgPlayer.socket.emit("item_spawn", drop);
                  }
                });
              }
            }
          }
        });
      });
    }

    broadcastPlayerUpdate(p);
  });

  // --- Mob AI movement + damage ---
  mobs.forEach(m => {
    // your AI chase/attack code here
  });

  // --- Mob spawning ---
  for (let zoneIndex = 0; zoneIndex < rarityZones.length; zoneIndex++) {
    if (countMobsInZone(zoneIndex) < maxMobsPerZone) {
      const x = zoneIndex * zoneWidth + Math.random() * zoneWidth;
      const y = Math.random() * world.height;
      spawnMob(x, y);
    }
  }

  // --- Mob despawn ---
  mobs.forEach(m => {
    if (Date.now() - m.spawnTime > 60000) {
      mobs.delete(m.id);
      io.emit("mob_dead", { id: m.id });
    }
  });

  // --- Broadcast mobs each tick ---
  broadcastMobs();
}, 50);

// ✅ Autosave OUTSIDE the 50ms loop
setInterval(() => {
  players.forEach(p => {
    if (p.username) {
      savePlayerState(p.username, p.inventory, p.hotbar);
    }
  });
}, 30000);

// Health check endpoint
app.get("/", (_req, res) => res.send("Florr backend OK"));

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
