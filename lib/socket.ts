import { Server as NetServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import type { NextApiResponse } from "next";

export type NextApiResponseWithSocket = NextApiResponse & {
  socket: {
    server: NetServer & { io?: SocketIOServer };
  };
};

interface Player {
  id: string;
  username: string;
  y: number;
  score: number;
  alive: boolean;
  powered: boolean;
  bigMode: boolean;
  pigColor: string;
  slot: number;
}

interface OnlinePlayer {
  id: string;
  username: string;
  pigColor: string;
}

interface Room {
  id: string;
  players: Map<string, Player>;
  host: string;
  started: boolean;
  startTime: number;
  seed: number;
  speed: number;
}

const rooms: Map<string, Room> = new Map();
// Players sitting in the lobby (not yet in a game room)
const lobbyPlayers: Map<string, OnlinePlayer> = new Map();

function broadcastLobby(io: SocketIOServer) {
  io.emit("lobby_players", Array.from(lobbyPlayers.values()));
}

export function initSocket(server: NetServer) {
  const io = new SocketIOServer(server, {
    path: "/api/socketio",
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: false,
    },
    allowEIO3: true,
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket: Socket) => {
    let currentRoom: string | null = null;
    let currentUser: string | null = null;

    // ── LOBBY ──────────────────────────────────────────────
    socket.on(
      "lobby_join",
      ({ username, pigColor }: { username: string; pigColor?: string }) => {
        currentUser = username;
        lobbyPlayers.set(socket.id, {
          id: socket.id,
          username,
          pigColor: pigColor || "pink",
        });
        broadcastLobby(io);
      },
    );

    socket.on("lobby_leave", () => {
      lobbyPlayers.delete(socket.id);
      broadcastLobby(io);
    });

    // Invite another player in lobby to a room
    socket.on(
      "invite_player",
      ({
        toId,
        roomId,
        speed,
      }: {
        toId: string;
        roomId: string;
        speed?: number;
      }) => {
        const from = lobbyPlayers.get(socket.id);
        if (!from) return;
        io.to(toId).emit("invite_received", {
          fromId: socket.id,
          fromUsername: from.username,
          roomId,
          speed: speed ?? 3,
        });
      },
    );

    // Invited player accepts → both navigate to same room
    socket.on(
      "invite_accept",
      ({
        roomId,
        fromId,
        speed,
      }: {
        roomId: string;
        fromId?: string;
        speed?: number;
      }) => {
        // Redirect the acceptor
        socket.emit("invite_go", { roomId, speed: speed ?? 3 });
        // Also send the host (inviter) so they go at the same time
        if (fromId) {
          io.to(fromId).emit("invite_go", { roomId, speed: speed ?? 3 });
        }
      },
    );

    socket.on(
      "join_room",
      ({
        roomId,
        username,
        pigColor,
        speed,
      }: {
        roomId: string;
        username: string;
        pigColor?: string;
        speed?: number;
      }) => {
        // Prevent duplicate join from the same socket (e.g. StrictMode reconnect)
        if (currentRoom === roomId) {
          // Already in this room — re-send full state
          const r = rooms.get(roomId);
          if (r) {
            socket.emit("room_state", {
              players: Array.from(r.players.values()),
              started: r.started,
              host: r.host,
              speed: r.speed,
            });
            if (r.started) {
              const elapsed = Math.floor((Date.now() - r.startTime) / 1000);
              const remaining = Math.max(0, 3 - elapsed);
              socket.emit("game_start", {
                countdown: remaining,
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
          rooms.set(roomId, {
            id: roomId,
            players: new Map(),
            host: socket.id,
            started: false,
            startTime: 0,
            seed: 0,
            speed: speed || 3,
          });
        }

        const room = rooms.get(roomId)!;

        // Prevent the same socket.id from being added twice
        if (room.players.has(socket.id)) return;

        // Enforce max 10 players
        if (room.players.size >= 10) return;

        const slot = room.players.size;
        room.players.set(socket.id, {
          id: socket.id,
          username,
          y: 200,
          score: 0,
          alive: true,
          powered: false,
          bigMode: false,
          pigColor: pigColor || "pink",
          slot,
        });

        socket.join(roomId);

        // Leave lobby list when entering a game room
        lobbyPlayers.delete(socket.id);
        broadcastLobby(io);

        // Broadcast full room state to EVERY player in the room so all lists stay in sync
        io.to(roomId).emit("room_state", {
          players: Array.from(room.players.values()),
          started: room.started,
          host: room.host,
          speed: room.speed,
        });

        // Players now wait in the room — host will emit room_ready to start
        // If room already started (race condition), send game_start to the new joiner only
        if (room.started) {
          const elapsed = Math.floor((Date.now() - room.startTime) / 1000);
          const remaining = Math.max(0, 3 - elapsed);
          socket.emit("game_start", {
            countdown: remaining,
            seed: room.seed,
            speed: room.speed,
          });
        }
      },
    );

    // Host explicitly starts the game
    socket.on("room_ready", () => {
      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      if (!room || room.started) return;
      if (socket.id !== room.host) return;
      if (room.players.size < 2) return;

      room.started = true;
      room.startTime = Date.now();
      room.seed = Math.floor(Math.random() * 4294967296);
      io.to(currentRoom).emit("game_start", {
        countdown: 3,
        seed: room.seed,
        speed: room.speed,
      });
    });

    // Host updates speed from waiting room
    socket.on("update_speed", ({ speed }: { speed: number }) => {
      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      if (!room || room.started) return;
      if (socket.id !== room.host) return;
      room.speed = speed;
      // Broadcast updated room_state so all players see the new speed
      io.to(currentRoom).emit("room_state", {
        players: Array.from(room.players.values()),
        started: room.started,
        host: room.host,
        speed: room.speed,
      });
    });

    socket.on(
      "player_update",
      (data: {
        y: number;
        score: number;
        alive: boolean;
        powered: boolean;
        bigMode: boolean;
      }) => {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const player = room.players.get(socket.id);
        if (player) {
          Object.assign(player, data);
          socket.to(currentRoom).emit("opponent_update", {
            id: socket.id,
            ...data,
          });
        }
      },
    );

    socket.on("player_died", ({ score }: { score: number }) => {
      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      if (!room) return;
      const player = room.players.get(socket.id);
      if (player) {
        player.alive = false;
        player.score = score;
      }

      io.to(currentRoom).emit("player_died", { id: socket.id, score });

      // Notify last survivor; only end when everyone is dead
      const alive = Array.from(room.players.values()).filter((p) => p.alive);
      if (alive.length === 1) {
        // Tell the survivor to keep playing but show target score
        const deadScores = Array.from(room.players.values())
          .filter((p) => !p.alive)
          .map((p) => p.score);
        const targetScore = deadScores.length ? Math.max(...deadScores) : 0;
        io.to(alive[0].id).emit("last_survivor", { targetScore });
      }
      if (alive.length === 0) {
        const allPlayers = Array.from(room.players.values());
        const winner = allPlayers.sort((a, b) => b.score - a.score)[0];
        io.to(currentRoom).emit("game_over_result", {
          winnerId: winner.id,
          winnerName: winner.username,
          scores: allPlayers.map((p) => ({
            id: p.id,
            username: p.username,
            score: p.score,
          })),
        });
        // Reset room and notify players to return to waiting room
        setTimeout(() => {
          if (rooms.has(currentRoom!)) {
            const r = rooms.get(currentRoom!)!;
            r.started = false;
            r.players.forEach((p) => {
              p.alive = true;
              p.score = 0;
              p.y = 200;
              p.powered = false;
              p.bigMode = false;
            });
            // Tell all players the room is reset so they can play again
            io.to(currentRoom!).emit("room_reset", {
              players: Array.from(r.players.values()),
              host: r.host,
              speed: r.speed,
            });
          }
        }, 5000);
      }
    });

    socket.on("disconnect", () => {
      // Remove from lobby
      lobbyPlayers.delete(socket.id);
      broadcastLobby(io);

      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      if (!room) return;
      room.players.delete(socket.id);
      io.to(currentRoom).emit("player_left", { id: socket.id });

      if (room.players.size === 0) {
        rooms.delete(currentRoom);
        return;
      }

      // If the host disconnected, assign the next player as host
      if (room.host === socket.id) {
        const nextHost = Array.from(room.players.values())[0];
        room.host = nextHost.id;
        // Re-assign slot 0 to new host
        room.players.forEach((p, pid) => {
          p.slot = Array.from(room.players.keys()).indexOf(pid);
        });
        // Broadcast updated room state so new host sees the start button
        io.to(currentRoom).emit("room_state", {
          players: Array.from(room.players.values()),
          started: room.started,
          host: room.host,
          speed: room.speed,
        });
      }
    });
  });

  return io;
}
