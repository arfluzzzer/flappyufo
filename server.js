// ─────────────────────────────────────────────────────────────────────────────
// Custom server — Next.js + Socket.IO dalam satu proses.
// Gantikan `next dev` / `next start` dengan `node server.js`.
//
// Dev:  node server.js
// Prod: set NODE_ENV=production && node server.js
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { createServer } = require("http");
const { Server } = require("socket.io");
const next = require("next");

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";

// ── State ──────────────────────────────────────────────────────────────────
const rooms = new Map();
const lobbyPlayers = new Map();
const chatMessages = new Map();
const lobbyChatMessages = [];
// username (lowercase) → socket.id — enforces single-device login
const activeUsers = new Map();

// ── Battle game state ──────────────────────────────────────────────────────
const battleRooms = new Map();
const BATTLE_SPAWN_X = [130, 670, 280, 520];

function getNextBattleTurn(room) {
  const alive = Array.from(room.players.values()).filter((p) => p.alive);
  if (alive.length <= 1) return null;
  const idx = alive.findIndex((p) => p.id === room.currentTurnId);
  return alive[(idx + 1) % alive.length].id;
}

function resetBattleRoom(room, roomId) {
  room.started = false;
  room.gameOver = false;
  room.currentTurnId = null;
  room.doubleThrowActive = false;
  room.rematchVotes.clear();
  if (room.resetTimeout) { clearTimeout(room.resetTimeout); room.resetTimeout = null; }
  Array.from(room.players.values()).forEach((p, _i, arr) => {
    const slot = Array.from(arr).indexOf(p);
    p.hp = 100;
    p.alive = true;
    p.x = BATTLE_SPAWN_X[slot] ?? 400;
    p.powerUps = { big: true, double: true, explosive: true };
  });
  io.to(roomId).emit("battle_room_state", {
    players: Array.from(room.players.values()),
    host: room.host,
    started: false,
  });
}

// Purge messages older than 1 hour every 5 minutes
setInterval(
  () => {
    const oneHourAgo = Date.now() - 3_600_000;
    for (const [roomId, msgs] of chatMessages.entries()) {
      const fresh = msgs.filter((m) => m.ts > oneHourAgo);
      if (fresh.length === 0) chatMessages.delete(roomId);
      else chatMessages.set(roomId, fresh);
    }
    const freshLobby = lobbyChatMessages.filter((m) => m.ts > oneHourAgo);
    lobbyChatMessages.length = 0;
    freshLobby.forEach((m) => lobbyChatMessages.push(m));
  },
  5 * 60 * 1000,
);

// ── Bootstrap ─────────────────────────────────────────────────────────────
// httpServer must be created BEFORE next() so Turbopack can attach its HMR
// WebSocket handler to the same server (Next.js 16 requirement).
const httpServer = createServer();
const app = next({ dev, port, httpServer });
const handle = app.getRequestHandler();

httpServer.on("request", (req, res) => {
  handle(req, res);
});

// ── Socket.IO ──────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  path: "/api/socketio",
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false,
  },
  allowEIO3: true,
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

function broadcastLobby() {
  io.emit("lobby_players", Array.from(lobbyPlayers.values()));
}

function getRoomList() {
  const gameList = Array.from(rooms.values())
    .filter((r) => r.players.size > 0)
    .map((r) => {
      const hostPlayer = Array.from(r.players.values()).find((p) => p.id === r.host);
      return {
        id: r.id,
        host: hostPlayer?.username || "?",
        playerCount: r.players.size,
        gameMode: r.gameMode || "flappy",
        speed: r.speed,
        hasPassword: !!r.password,
        started: r.started,
      };
    });
  const battleList = Array.from(battleRooms.values())
    .filter((br) => br.players.size > 0)
    .map((br) => {
      const hostPlayer = Array.from(br.players.values()).find((p) => p.id === br.host);
      return {
        id: br.id,
        host: hostPlayer?.username || "?",
        playerCount: br.players.size,
        gameMode: "battle",
        speed: 0,
        hasPassword: false,
        started: br.started,
      };
    });
  return [...gameList, ...battleList];
}

function broadcastRooms() {
  io.emit("room_list", getRoomList());
}

// ── Socket handlers ────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;
  let currentUser = null;
  let currentBattleRoom = null;

  // ── LOBBY ──────────────────────────────────────────────────────────────
  socket.on("lobby_join", ({ username, pigColor, character }) => {
    // Single-device enforcement: kick existing session for this username,
    // but only if the previous socket is NOT currently in a game or battle room.
    if (username) {
      const key = String(username).toLowerCase();
      const prevId = activeUsers.get(key);
      if (prevId && prevId !== socket.id) {
        const prevIsInGame =
          Array.from(battleRooms.values()).some((br) => br.players.has(prevId)) ||
          Array.from(rooms.values()).some((r) => r.players.has(prevId));
        if (!prevIsInGame) {
          const prevSocket = io.sockets.sockets.get(prevId);
          if (prevSocket) {
            prevSocket.emit("session_kicked", { reason: "Login dari perangkat lain terdeteksi." });
            prevSocket.disconnect(true);
          }
        }
      }
      activeUsers.set(key, socket.id);
    }

    currentUser = username;
    lobbyPlayers.set(socket.id, {
      id: socket.id,
      username,
      pigColor: pigColor || "pink",
      character: character || "pig",
    });
    socket.join("lobby");
    broadcastLobby();
    socket.emit("room_list", getRoomList());
    const oneHourAgo = Date.now() - 3_600_000;
    const history = lobbyChatMessages
      .filter((m) => m.ts > oneHourAgo)
      .slice(-50);
    if (history.length > 0) socket.emit("lobby_chat_history", history);
  });

  socket.on("lobby_leave", () => {
    lobbyPlayers.delete(socket.id);
    socket.leave("lobby");
    broadcastLobby();
  });

  socket.on("request_room_list", () => {
    socket.emit("room_list", getRoomList());
  });

  socket.on("lobby_chat_send", ({ text }) => {
    if (!currentUser) return;
    const trimmed = String(text).trim().slice(0, 200);
    if (!trimmed) return;
    const player = lobbyPlayers.get(socket.id);
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      username: currentUser,
      pigColor: player?.pigColor || "pink",
      text: trimmed,
      ts: Date.now(),
    };
    lobbyChatMessages.push(msg);
    if (lobbyChatMessages.length > 200)
      lobbyChatMessages.splice(0, lobbyChatMessages.length - 200);
    io.emit("lobby_chat_message", msg);
  });

  socket.on("lobby_poke", ({ toId }) => {
    const from = lobbyPlayers.get(socket.id);
    if (!from) return;
    io.to(toId).emit("poke_received", {
      fromId: socket.id,
      fromUsername: from.username,
    });
  });

  socket.on("invite_player", ({ toId, roomId, speed, gameMode }) => {
    const from = lobbyPlayers.get(socket.id);
    if (!from) return;
    io.to(toId).emit("invite_received", {
      fromId: socket.id,
      fromUsername: from.username,
      roomId,
      speed: speed ?? 3,
      gameMode: gameMode || "flappy",
    });
  });

  socket.on("invite_accept", ({ roomId, fromId, speed, gameMode }) => {
    socket.emit("invite_go", { roomId, speed: speed ?? 3, gameMode: gameMode || "flappy" });
    if (fromId) io.to(fromId).emit("invite_go", { roomId, speed: speed ?? 3, gameMode: gameMode || "flappy" });
  });

  // ── ROOM ───────────────────────────────────────────────────────────────
  socket.on("join_room", ({ roomId, username, pigColor, character, speed, password, gameMode }) => {
    if (currentRoom === roomId) {
      const r = rooms.get(roomId);
      if (r) {
        socket.emit("room_state", {
          players: Array.from(r.players.values()),
          started: r.started,
          host: r.host,
          speed: r.speed,
          gameMode: r.gameMode || "flappy",
        });
        if (r.started) {
          const elapsed = Math.floor((Date.now() - r.startTime) / 1000);
          socket.emit("game_start", {
            countdown: Math.max(0, 3 - elapsed),
            seed: r.seed,
            speed: r.speed,
          });
        }
      }
      return;
    }

    currentRoom = roomId;
    currentUser = username;

    if (!rooms.has(roomId)) {
      // First joiner creates the room
      rooms.set(roomId, {
        id: roomId,
        players: new Map(),
        host: socket.id,
        started: false,
        startTime: 0,
        seed: 0,
        speed: speed || 3,
        gameMode: gameMode || "flappy",
        password: password || null,
        resetTimeout: null,
        gameOver: false,
        rematchVotes: new Set(),
      });
    } else {
      // Validate password for existing rooms
      const existing = rooms.get(roomId);
      if (existing.password && existing.password !== (password || "")) {
        currentRoom = null;
        socket.emit("join_room_error", { error: "Password room salah" });
        return;
      }
    }

    const room = rooms.get(roomId);
    if (room.players.has(socket.id)) return;
    if (room.players.size >= 10) return;

    room.players.set(socket.id, {
      id: socket.id,
      username,
      y: 300,
      score: 0,
      alive: true,
      powered: false,
      bigMode: false,
      pigColor: pigColor || "pink",
      character: character || "pig",
      slot: room.players.size,
    });

    socket.join(roomId);
    socket.leave("lobby");
    lobbyPlayers.delete(socket.id);
    broadcastLobby();
    broadcastRooms();

    io.to(roomId).emit("room_state", {
      players: Array.from(room.players.values()),
      started: room.started,
      host: room.host,
      speed: room.speed,
      gameMode: room.gameMode || "flappy",
    });

    if (room.started) {
      const elapsed = Math.floor((Date.now() - room.startTime) / 1000);
      socket.emit("game_start", {
        countdown: Math.max(0, 3 - elapsed),
        seed: room.seed,
        speed: room.speed,
      });
    }

    const oneHourAgo = Date.now() - 3_600_000;
    const history = (chatMessages.get(roomId) || []).filter(
      (m) => m.ts > oneHourAgo,
    );
    if (history.length > 0) socket.emit("chat_history", history);
  });

  socket.on("chat_send", ({ text }) => {
    if (!currentRoom || !currentUser) return;
    const trimmed = String(text).trim().slice(0, 200);
    if (!trimmed) return;
    const player = rooms.get(currentRoom)?.players.get(socket.id);
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      username: currentUser,
      pigColor: player?.pigColor || "pink",
      text: trimmed,
      ts: Date.now(),
    };
    if (!chatMessages.has(currentRoom)) chatMessages.set(currentRoom, []);
    chatMessages.get(currentRoom).push(msg);
    io.to(currentRoom).emit("chat_message", msg);
  });

  socket.on("room_ready", () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.started || socket.id !== room.host) return;
    if (room.players.size < 2) return;
    room.started = true;
    room.startTime = Date.now();
    room.seed = Math.floor(Math.random() * 4294967296);
    broadcastRooms();
    io.to(currentRoom).emit("game_start", {
      countdown: 3,
      seed: room.seed,
      speed: room.speed,
    });
  });

  socket.on("update_speed", ({ speed }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.started || socket.id !== room.host) return;
    room.speed = speed;
    io.to(currentRoom).emit("room_state", {
      players: Array.from(room.players.values()),
      started: room.started,
      host: room.host,
      speed: room.speed,
    });
  });

  socket.on("player_update", (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) {
      Object.assign(player, data);
      socket
        .to(currentRoom)
        .emit("opponent_update", { id: socket.id, ...data });
    }
  });

  socket.on("player_died", ({ score }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) {
      player.alive = false;
      player.score = score;
    }

    io.to(currentRoom).emit("player_died", { id: socket.id, score });

    const alive = Array.from(room.players.values()).filter((p) => p.alive);
    if (alive.length === 1) {
      const deadScores = Array.from(room.players.values())
        .filter((p) => !p.alive)
        .map((p) => p.score);
      io.to(alive[0].id).emit("last_survivor", {
        targetScore: deadScores.length ? Math.max(...deadScores) : 0,
      });
    }
    if (alive.length === 0) {
      const allPlayers = Array.from(room.players.values());
      const winner = allPlayers.sort((a, b) => b.score - a.score)[0];
      room.gameOver = true;
      room.rematchVotes.clear();
      io.to(currentRoom).emit("game_over_result", {
        winnerId: winner.id,
        winnerName: winner.username,
        scores: allPlayers.map((p) => ({
          id: p.id,
          username: p.username,
          score: p.score,
        })),
      });
      // Fallback: auto-reset to waiting room after 60s if no rematch
      room.resetTimeout = setTimeout(() => {
        if (!rooms.has(currentRoom)) return;
        const r = rooms.get(currentRoom);
        r.resetTimeout = null;
        r.gameOver = false;
        r.rematchVotes.clear();
        r.started = false;
        r.players.forEach((p) => {
          p.alive = true;
          p.score = 0;
          p.y = 300;
          p.powered = false;
          p.bigMode = false;
        });
        io.to(currentRoom).emit("room_reset", {
          players: Array.from(r.players.values()),
          host: r.host,
          speed: r.speed,
        });
      }, 60000);
    }
  });

  socket.on("request_room_reset", () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.started || socket.id !== room.host) return;
    if (room.resetTimeout) {
      clearTimeout(room.resetTimeout);
      room.resetTimeout = null;
    }
    room.gameOver = false;
    room.rematchVotes.clear();
    room.started = false;
    room.players.forEach((p) => {
      p.alive = true;
      p.score = 0;
      p.y = 300;
      p.powered = false;
      p.bigMode = false;
    });
    broadcastRooms();
    io.to(currentRoom).emit("room_reset", {
      players: Array.from(room.players.values()),
      host: room.host,
      speed: room.speed,
    });
  });

  socket.on("vote_rematch", () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.gameOver) return;
    room.rematchVotes.add(socket.id);
    const votes = room.rematchVotes.size;
    const total = room.players.size;
    io.to(currentRoom).emit("rematch_votes", { votes, total });
    if (votes >= total && total >= 2) {
      if (room.resetTimeout) {
        clearTimeout(room.resetTimeout);
        room.resetTimeout = null;
      }
      room.gameOver = false;
      room.rematchVotes.clear();
      room.started = true;
      room.startTime = Date.now();
      room.seed = Math.floor(Math.random() * 4294967296);
      room.players.forEach((p) => {
        p.alive = true;
        p.score = 0;
        p.y = 300;
        p.powered = false;
        p.bigMode = false;
      });
      broadcastRooms();
      io.to(currentRoom).emit("game_start", {
        countdown: 3,
        seed: room.seed,
        speed: room.speed,
      });
    }
  });

  // ── BATTLE ─────────────────────────────────────────────────────────────
  socket.on("battle_join", ({ roomId, username, pigColor, character: _character }) => {
    void _character;
    if (!roomId) return;
    currentBattleRoom = roomId;
    currentUser = username;
    if (username) {
      const key = String(username).toLowerCase();
      activeUsers.set(key, socket.id);
    }

    if (!battleRooms.has(roomId)) {
      battleRooms.set(roomId, {
        id: roomId,
        players: new Map(),
        host: socket.id,
        started: false,
        gameOver: false,
        currentTurnId: null,
        doubleThrowActive: false,
        rematchVotes: new Set(),
        resetTimeout: null,
      });
    }

    const br = battleRooms.get(roomId);
    // If room exists but is empty, make rejoining player the host
    if (br.players.size === 0) br.host = socket.id;
    if (br.players.has(socket.id)) {
      // Rejoin — resend state
      socket.join(roomId);
      socket.emit("battle_room_state", {
        players: Array.from(br.players.values()),
        host: br.host,
        started: br.started,
      });
      return;
    }
    if (br.players.size >= 4) { socket.emit("battle_join_error", { error: "Room penuh (maks 4)" }); return; }

    const slot = br.players.size;
    const charType = slot % 2 === 0 ? "cat" : "dog";
    br.players.set(socket.id, {
      id: socket.id,
      username,
      character: charType,
      x: BATTLE_SPAWN_X[slot] ?? 400,
      hp: 100,
      maxHp: 100,
      alive: true,
      powerUps: { big: true, double: true, explosive: true },
      pigColor: pigColor || "pink",
      slot,
    });

    socket.join(roomId);
    lobbyPlayers.delete(socket.id);
    broadcastLobby();
    broadcastRooms();

    io.to(roomId).emit("battle_room_state", {
      players: Array.from(br.players.values()),
      host: br.host,
      started: br.started,
    });
  });

  socket.on("battle_start", () => {
    if (!currentBattleRoom) return;
    const br = battleRooms.get(currentBattleRoom);
    if (!br || br.started || socket.id !== br.host || br.players.size < 2) return;
    br.started = true;
    br.gameOver = false;
    br.doubleThrowActive = false;
    br.currentTurnId = Array.from(br.players.keys())[0];
    io.to(currentBattleRoom).emit("battle_game_start", {
      players: Array.from(br.players.values()),
      currentTurnId: br.currentTurnId,
    });
  });

  socket.on("battle_move", ({ x }) => {
    if (!currentBattleRoom) return;
    const br = battleRooms.get(currentBattleRoom);
    if (!br || !br.started || socket.id !== br.currentTurnId) return;
    const p = br.players.get(socket.id);
    if (!p || !p.alive) return;
    const minX = p.character === "dog" ? 415 : 50;
    const maxX = p.character === "cat" ? 385 : 750;
    p.x = Math.max(minX, Math.min(maxX, x));
    socket.to(currentBattleRoom).emit("battle_player_moved", { id: socket.id, x: p.x });
  });

  socket.on("battle_throw", ({ angle, power, powerUp, startX }) => {
    if (!currentBattleRoom) return;
    const br = battleRooms.get(currentBattleRoom);
    if (!br || !br.started || socket.id !== br.currentTurnId) return;
    const p = br.players.get(socket.id);
    if (!p || !p.alive) return;
    if (powerUp && p.powerUps[powerUp]) p.powerUps[powerUp] = false;
    if (powerUp === "double" && !br.doubleThrowActive) br.doubleThrowActive = true;
    io.to(currentBattleRoom).emit("battle_projectile", {
      throwerId: socket.id,
      angle,
      power,
      powerUp: powerUp || null,
      startX,
    });
  });

  socket.on("battle_throw_result", ({ hits }) => {
    if (!currentBattleRoom) return;
    const br = battleRooms.get(currentBattleRoom);
    if (!br || !br.started || socket.id !== br.currentTurnId) return;

    const safeHits = Array.isArray(hits) ? hits : [];
    safeHits.forEach(({ targetId, damage }) => {
      const t = br.players.get(targetId);
      if (t && t.alive) {
        t.hp = Math.max(0, t.hp - Math.round(damage));
        if (t.hp <= 0) { t.hp = 0; t.alive = false; }
      }
    });

    const alive = Array.from(br.players.values()).filter((p) => p.alive);

    // Double throw — intermediate state: don't advance turn yet
    if (br.doubleThrowActive) {
      br.doubleThrowActive = false;
      io.to(currentBattleRoom).emit("battle_state_update", {
        players: Array.from(br.players.values()),
        currentTurnId: br.currentTurnId,
        hits: safeHits,
        awaitingDouble: true,
      });
      return;
    }

    // Game over?
    if (alive.length <= 1) {
      br.gameOver = true;
      br.started = false;
      const winner = alive[0] ?? Array.from(br.players.values()).sort((a, b) => b.hp - a.hp)[0];
      io.to(currentBattleRoom).emit("battle_game_over", {
        winnerId: winner?.id ?? null,
        winnerName: winner?.username ?? "?",
        players: Array.from(br.players.values()),
      });
      br.resetTimeout = setTimeout(() => resetBattleRoom(br, currentBattleRoom), 60_000);
      return;
    }

    const nextId = getNextBattleTurn(br);
    br.currentTurnId = nextId;
    io.to(currentBattleRoom).emit("battle_state_update", {
      players: Array.from(br.players.values()),
      currentTurnId: nextId,
      hits: safeHits,
      awaitingDouble: false,
    });
  });

  socket.on("battle_vote_rematch", () => {
    if (!currentBattleRoom) return;
    const br = battleRooms.get(currentBattleRoom);
    if (!br || !br.gameOver) return;
    br.rematchVotes.add(socket.id);
    const votes = br.rematchVotes.size;
    const total = br.players.size;
    io.to(currentBattleRoom).emit("battle_rematch_votes", { votes, total });
    if (votes >= total && total >= 2) resetBattleRoom(br, currentBattleRoom);
  });

  socket.on("battle_pick_slot", ({ slot }) => {
    if (!currentBattleRoom) {
      for (const [rid, br] of battleRooms.entries()) {
        if (br.players.has(socket.id)) { currentBattleRoom = rid; break; }
      }
    }
    if (!currentBattleRoom) return;
    const br = battleRooms.get(currentBattleRoom);
    if (!br || br.started) return;
    const me = br.players.get(socket.id);
    if (!me) return;
    const slotNum = parseInt(slot, 10);
    if (isNaN(slotNum) || slotNum < 0 || slotNum > 3) return;
    // Reject if slot is taken by someone else
    const occupant = Array.from(br.players.values()).find(
      (p) => p.slot === slotNum && p.id !== socket.id
    );
    if (occupant) return;
    me.slot = slotNum;
    me.x = BATTLE_SPAWN_X[slotNum] ?? 400;
    me.character = slotNum % 2 === 0 ? "cat" : "dog";
    io.to(currentBattleRoom).emit("battle_room_state", {
      players: Array.from(br.players.values()),
      host: br.host,
      started: br.started,
    });
  });

  socket.on("disconnect", () => {
    lobbyPlayers.delete(socket.id);
    // Remove from activeUsers only if this socket is still the registered one
    if (currentUser) {
      const key = String(currentUser).toLowerCase();
      if (activeUsers.get(key) === socket.id) activeUsers.delete(key);
    }
    broadcastLobby();

    // ── Regular room cleanup ────────────────────────────────────────────
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.rematchVotes.delete(socket.id);
        room.players.delete(socket.id);
        io.to(currentRoom).emit("player_left", { id: socket.id });
        broadcastRooms();

        if (room.players.size === 0) {
          rooms.delete(currentRoom);
        } else {
          // Broadcast updated rematch count if in rematch phase
          if (room.gameOver) {
            io.to(currentRoom).emit("rematch_votes", {
              votes: room.rematchVotes.size,
              total: room.players.size,
            });
          }

          if (room.host === socket.id) {
            const nextHost = Array.from(room.players.values())[0];
            room.host = nextHost.id;
            room.players.forEach((p, pid) => {
              p.slot = Array.from(room.players.keys()).indexOf(pid);
            });
            io.to(currentRoom).emit("room_state", {
              players: Array.from(room.players.values()),
              started: room.started,
              host: room.host,
              speed: room.speed,
            });
          }
        }
      }
    }

    // ── Battle room cleanup ─────────────────────────────────────────────
    if (currentBattleRoom) {
      const br = battleRooms.get(currentBattleRoom);
      if (br) {
        br.players.delete(socket.id);
        io.to(currentBattleRoom).emit("battle_player_left", { id: socket.id });
        broadcastRooms();

        if (br.players.size === 0) {
          if (br.resetTimeout) clearTimeout(br.resetTimeout);
          battleRooms.delete(currentBattleRoom);
        } else {
          if (br.host === socket.id) {
            br.host = Array.from(br.players.keys())[0];
          }
          // If disconnected player was the current turn, skip to next
          if (br.started && !br.gameOver && br.currentTurnId === socket.id) {
            const nextId = getNextBattleTurn(br);
            br.currentTurnId = nextId;
            const alive = Array.from(br.players.values()).filter((p) => p.alive);
            if (alive.length <= 1) {
              br.gameOver = true; br.started = false;
              const winner = alive[0] ?? null;
              io.to(currentBattleRoom).emit("battle_game_over", {
                winnerId: winner?.id ?? null,
                winnerName: winner?.username ?? "?",
                players: Array.from(br.players.values()),
              });
              br.resetTimeout = setTimeout(() => resetBattleRoom(br, currentBattleRoom), 60_000);
            } else {
              io.to(currentBattleRoom).emit("battle_state_update", {
                players: Array.from(br.players.values()),
                currentTurnId: nextId,
                hits: [],
                awaitingDouble: false,
              });
            }
          }
          io.to(currentBattleRoom).emit("battle_room_state", {
            players: Array.from(br.players.values()),
            host: br.host,
            started: br.started,
          });
        }
      }
    }
  });
});


// ── Periodic room list sync ────────────────────────────────────────────────
// Pushes a fresh room list to every connected socket every 4 s so the lobby
// never shows stale data even if a client missed the event-driven broadcast.
setInterval(() => {
  io.emit("room_list", getRoomList());
}, 4000);

// ── Start ──────────────────────────────────────────────────────────────────
app.prepare().then(() => {
  httpServer.listen(port, () => {
    const env = dev ? "development" : "production";
    console.log(`> Ready on http://localhost:${port} [${env}]`);
  });
});
