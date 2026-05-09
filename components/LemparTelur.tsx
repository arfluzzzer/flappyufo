"use client";
import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";

// ── Constants ─────────────────────────────────────────────────────────────
const W = 800;
const H = 540;
const EGG_R = 18;
const PLAT_H = 14;
const PLATFORM_SPACING = 100;
const JUMP_SPEED = 13.5;
const GRAVITY = 0.30;
const CAM_LERP = 0.07;
const ZONE_SIZE = 100;
const GROUND_Y = 0;
const SYNC_MS = 80;

const EGG_SPAWN_X = [100, 250, 400, 550, 700];
const EGG_COLORS  = ["#ff9de2", "#ffd580", "#a0e8af", "#80cfff", "#d4a0ff"];
const PLAT_COLORS = ["#7c5cbf", "#5b8dd9", "#45c9b0", "#e8a838", "#e05f5f", "#57bb8a"];

const ZONE_GRADIENTS: [string, string][] = [
  ["#1a0540", "#6b21a8"],
  ["#0f172a", "#1e40af"],
  ["#042f2e", "#0d9488"],
  ["#052e16", "#16a34a"],
  ["#431407", "#c2410c"],
  ["#3b0764", "#7e22ce"],
  ["#1e3a5f", "#0ea5e9"],
  ["#4a1942", "#c026d3"],
  ["#0c1a0c", "#365314"],
  ["#1c1917", "#78350f"],
];

type Phase = "lobby" | "playing" | "spectating" | "gameover";
type EState = "resting" | "jumping" | "dead";

interface SrvPlayer {
  id: string; username: string; pigColor: string;
  slot: number; alive: boolean; highestLevel: number;
}
interface Other {
  id: string; username: string; slot: number;
  worldY: number; x: number; vy: number;
  state: EState; platformLevel: number;
}
interface GS {
  phase: Phase;
  players: SrvPlayer[];
  host: string;
  startTime: number;
  playStart: number;       // Date.now() when my play began (for score time bonus)
  worldY: number; x: number; vy: number;
  myState: EState; platformLevel: number; highestLevel: number; mySlot: number;
  camY: number;
  others: Map<string, Other>;
  winnerId: string | null; winnerName: string;
  rematchVotes: number; rematchTotal: number;
  jumpPressed: boolean; jumpConsumed: boolean;
  lastSync: number;
  solo: boolean;
  myPlatOffsetX: number; // egg's x offset from platform center while resting
}

interface Props { roomId: string; username: string; pigColor: string; character: string; }

// ── Rank tier ─────────────────────────────────────────────────────────────
function rankTier(level: number): { label: string; color: string; icon: string } {
  if (level >= 100) return { label: "Legenda",  color: "#f59e0b", icon: "👑" };
  if (level >= 50)  return { label: "Ahli",     color: "#a78bfa", icon: "💎" };
  if (level >= 25)  return { label: "Mahir",    color: "#f87171", icon: "🔥" };
  if (level >= 10)  return { label: "Bagus",    color: "#6ee7b7", icon: "⭐" };
  if (level >= 5)   return { label: "Biasa",    color: "#93c5fd", icon: "🐣" };
  return               { label: "Pemula",    color: "#d1d5db", icon: "🥚" };
}

function calcScore(level: number, ms: number): number {
  const platScore  = level * 10;
  const timeSecs   = ms / 1000;
  const timeBonus  = Math.max(0, Math.round(200 - timeSecs * 0.5));
  return platScore + timeBonus;
}

// ── Pure geometry ─────────────────────────────────────────────────────────
function screenY(worldY: number, camY: number) { return H - (worldY - camY); }
function platWY(level: number) { return GROUND_Y + level * PLATFORM_SPACING; }
function platCX(level: number, elapsed: number) {
  if (level === 0) return W / 2;
  const amp   = Math.max(55, 230 - level * 1.5);
  const freq  = 0.0006 + level * 0.000021;
  const phase = (level * 1.618) % (2 * Math.PI);
  return W / 2 + amp * Math.sin(elapsed * freq + phase);
}
function platW(level: number) { return level === 0 ? W - 20 : Math.max(40, 112 - level * 0.6); }
function platCol(level: number) { return PLAT_COLORS[level % PLAT_COLORS.length]; }
function zoneIdx(level: number) { return Math.floor(level / ZONE_SIZE) % ZONE_GRADIENTS.length; }

// ── Audio ─────────────────────────────────────────────────────────────────
let _actx: AudioContext | null = null;
function actx() { return (_actx ??= new AudioContext()); }
function tone(freq: number, dur: number, vol = 0.18, type: OscillatorType = "sine") {
  try {
    const c = actx(), o = c.createOscillator(), g = c.createGain();
    o.connect(g); g.connect(c.destination);
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.start(); o.stop(c.currentTime + dur);
  } catch { /* ignore */ }
}
const sndJump = () => tone(520, 0.12, 0.14, "square");
const sndLand = () => tone(300, 0.09, 0.12);
const sndDie  = () => { tone(220, 0.18, 0.2, "sawtooth"); setTimeout(() => tone(160, 0.22, 0.14, "sawtooth"), 80); };
const sndWin  = () => [523,659,784,1047].forEach((f,i) => setTimeout(() => tone(f, 0.18, 0.18), i * 90));

// ── Draw helpers ──────────────────────────────────────────────────────────
function drawBg(ctx: CanvasRenderingContext2D, camY: number, level: number) {
  const [top, bot] = ZONE_GRADIENTS[zoneIdx(level)];
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, top); g.addColorStop(1, bot);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (level < 50 || zoneIdx(level) <= 1) {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    const seed = Math.floor(camY / 180);
    for (let i = 0; i < 40; i++) {
      ctx.fillRect(((seed * 137 + i * 73) & 0xffff) % W, ((seed * 53 + i * 29) & 0xffff) % H, 1.5, 1.5);
    }
  }
}

function drawGround(ctx: CanvasRenderingContext2D, camY: number) {
  const gy = screenY(GROUND_Y, camY);
  if (gy > H + 80) return;
  const tg = ctx.createLinearGradient(0, gy - 60, 0, gy);
  tg.addColorStop(0, "rgba(0,0,0,0)"); tg.addColorStop(1, "#4a3728");
  ctx.fillStyle = tg; ctx.fillRect(0, gy - 60, W, 60);
  ctx.fillStyle = "#5c4033"; ctx.fillRect(0, gy, W, Math.max(0, H - gy + 10));
  ctx.fillStyle = "#4ade80"; ctx.fillRect(0, gy, W, 8);

  const houses = [
    { x: 30,  w: 150, h: 120, col: "#f5deb3" },
    { x: 220, w: 200, h: 150, col: "#deb887" },
    { x: 470, w: 130, h: 110, col: "#e8c99a" },
    { x: 640, w: 140, h: 130, col: "#f0d9b5" },
  ];
  for (const h of houses) {
    const top = gy - h.h;
    ctx.fillStyle = h.col; ctx.fillRect(h.x, top, h.w, h.h);
    ctx.fillStyle = "#7f4f24";
    ctx.beginPath(); ctx.moveTo(h.x - 10, top); ctx.lineTo(h.x + h.w / 2, top - 40); ctx.lineTo(h.x + h.w + 10, top); ctx.closePath(); ctx.fill();
    const dw = 28, dh = 46, dx = h.x + h.w / 2 - 14;
    ctx.fillStyle = "#7c3f00"; ctx.fillRect(dx, gy - dh, dw, dh);
    ctx.fillStyle = "#fbbf24"; ctx.beginPath(); ctx.arc(dx + dw - 7, gy - dh / 2, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#bae6fd"; ctx.strokeStyle = "#7c3f00"; ctx.lineWidth = 2;
    const wy = top + 22;
    for (const wx of [h.x + 12, h.x + h.w - 42]) {
      ctx.fillRect(wx, wy, 26, 22); ctx.strokeRect(wx, wy, 26, 22);
      ctx.beginPath(); ctx.moveTo(wx + 13, wy); ctx.lineTo(wx + 13, wy + 22);
      ctx.moveTo(wx, wy + 11); ctx.lineTo(wx + 26, wy + 11); ctx.stroke();
    }
    ctx.fillStyle = "#16a34a";
    for (const bx of [h.x + 5, h.x + h.w - 30]) {
      ctx.beginPath(); ctx.arc(bx + 12, gy, 14, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawPlat(ctx: CanvasRenderingContext2D, level: number, elapsed: number, camY: number) {
  const cx = platCX(level, elapsed), pw = platW(level);
  const sy = screenY(platWY(level), camY);
  if (sy < -PLAT_H - 4 || sy > H + 4) return;
  ctx.fillStyle = platCol(level);
  ctx.beginPath(); ctx.roundRect(cx - pw / 2, sy, pw, PLAT_H, 5); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath(); ctx.roundRect(cx - pw / 2, sy, pw, 4, [5, 5, 0, 0]); ctx.fill();
}

function drawEgg(ctx: CanvasRenderingContext2D, x: number, sy: number, color: string, label: string, dead: boolean) {
  ctx.save(); ctx.globalAlpha = dead ? 0.35 : 1;
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath(); ctx.ellipse(x, sy + EGG_R + 3, EGG_R * 0.72, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(x, sy, EGG_R * 0.85, EGG_R, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath(); ctx.ellipse(x - EGG_R * 0.28, sy - EGG_R * 0.3, EGG_R * 0.28, EGG_R * 0.18, -0.4, 0, Math.PI * 2); ctx.fill();
  if (dead) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x-7,sy-7); ctx.lineTo(x+7,sy+7); ctx.moveTo(x+7,sy-7); ctx.lineTo(x-7,sy+7); ctx.stroke();
  }
  ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
  ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 3;
  ctx.strokeText(label, x, sy - EGG_R - 5);
  ctx.fillStyle = "#fff"; ctx.fillText(label, x, sy - EGG_R - 5);
  ctx.restore();
}

function drawHUD(ctx: CanvasRenderingContext2D, level: number, players: SrvPlayer[], myId: string, solo: boolean) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.beginPath(); ctx.roundRect(8, 8, 165, 32, 8); ctx.fill();
  ctx.fillStyle = "#fde68a"; ctx.font = "bold 15px sans-serif"; ctx.textAlign = "left";
  ctx.fillText(`Platform: ${level}  ${rankTier(level).icon}`, 18, 30);

  if (!solo) {
    const sorted = [...players].sort((a, b) => (a.alive === b.alive ? 0 : a.alive ? -1 : 1));
    sorted.forEach((p, i) => {
      ctx.fillStyle = p.alive ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.22)";
      ctx.beginPath(); ctx.roundRect(W - 152, 8 + i * 26, 144, 22, 5); ctx.fill();
      ctx.fillStyle = p.alive ? (p.id === myId ? "#fde68a" : "#fff") : "#777";
      ctx.font = p.id === myId ? "bold 12px sans-serif" : "12px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`${p.alive ? "🟢" : "💀"} ${p.username} L${p.highestLevel}`, W - 12, 8 + i * 26 + 15);
    });
  }
  ctx.restore();
}

const PLACE_MEDALS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

// ── Component ─────────────────────────────────────────────────────────────
export default function LemparTelur({ roomId, username, pigColor }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const socketRef  = useRef<Socket | null>(null);
  const myIdRef    = useRef("solo-player");
  const rafRef     = useRef(0);

  const isSolo = roomId === "solo";

  const gs = useRef<GS>({
    phase:         isSolo ? "playing" : "lobby",
    players:       [],
    host:          "",
    startTime:     isSolo ? Date.now() : 0,
    playStart:     isSolo ? Date.now() : 0,
    worldY:        0, x: W / 2, vy: 0,
    myState:       "resting",
    platformLevel: 0, highestLevel: 0, mySlot: 0,
    camY:          -H * 0.35,
    others:        new Map(),
    winnerId:      null, winnerName: "",
    rematchVotes:  0, rematchTotal: 0,
    jumpPressed:   false, jumpConsumed: false,
    lastSync:      0,
    solo:          isSolo,
    myPlatOffsetX: 0,
  }).current;

  // ── Socket (multi only) ───────────────────────────────────────────────
  useEffect(() => {
    if (isSolo) return;

    const exUrl      = process.env.NEXT_PUBLIC_SOCKET_URL || "";
    const socketPath = exUrl ? "/socket.io" : "/api/socketio";
    const socket = io(exUrl || (typeof window !== "undefined" ? window.location.origin : ""), {
      path: socketPath,
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      myIdRef.current = socket.id ?? "?";
      socket.emit("egg_join", { roomId, username, pigColor, character: "egg" });
    });

    socket.on("egg_room_state", ({ players, host, started }: { players: SrvPlayer[]; host: string; started: boolean }) => {
      gs.players = players; gs.host = host;
      if (!started) gs.phase = "lobby";
      const me = players.find(p => p.id === myIdRef.current);
      if (me) { gs.mySlot = me.slot; gs.x = EGG_SPAWN_X[me.slot] ?? W / 2; }
    });

    socket.on("egg_join_error", ({ error }: { error: string }) => {
      alert(error); window.location.href = "/lobby";
    });

    socket.on("egg_game_start", ({ players, startTime }: { players: SrvPlayer[]; startTime: number }) => {
      gs.players = players; gs.startTime = startTime;
      gs.phase = "playing"; gs.worldY = 0; gs.vy = 0;
      gs.myState = "resting"; gs.platformLevel = 0; gs.highestLevel = 0;
      gs.camY = -H * 0.35; gs.jumpPressed = false; gs.jumpConsumed = false;
      gs.playStart = Date.now();
      gs.myPlatOffsetX = 0;
      gs.others.clear();
      const me = players.find(p => p.id === myIdRef.current);
      if (me) { gs.mySlot = me.slot; gs.x = EGG_SPAWN_X[me.slot] ?? W / 2; }
      players.forEach(p => {
        if (p.id !== myIdRef.current)
          gs.others.set(p.id, { id: p.id, username: p.username, slot: p.slot, worldY: 0, x: EGG_SPAWN_X[p.slot] ?? W/2, vy: 0, state: "resting", platformLevel: 0 });
      });
    });

    socket.on("egg_player_jumped", ({ id }: { id: string }) => {
      const o = gs.others.get(id); if (o) { o.state = "jumping"; o.vy = JUMP_SPEED; }
    });
    socket.on("egg_player_landed", ({ id, level }: { id: string; level: number }) => {
      const o = gs.others.get(id); if (o) { o.state = "resting"; o.vy = 0; o.platformLevel = level; o.worldY = platWY(level); }
    });
    socket.on("egg_player_sync", ({ id, worldY, vy, state }: { id: string; worldY: number; vy: number; state: EState }) => {
      const o = gs.others.get(id); if (o) { o.worldY = worldY; o.vy = vy; o.state = state; }
    });
    socket.on("egg_player_died", ({ id, players }: { id: string; players: SrvPlayer[] }) => {
      gs.players = players;
      const o = gs.others.get(id); if (o) o.state = "dead";
      if (id === myIdRef.current && gs.phase === "playing") { gs.myState = "dead"; gs.phase = "spectating"; sndDie(); }
    });
    socket.on("egg_game_over", ({ winnerId, winnerName, players }: { winnerId: string|null; winnerName: string; players: SrvPlayer[] }) => {
      gs.phase = "gameover"; gs.winnerId = winnerId; gs.winnerName = winnerName;
      gs.players = players; gs.rematchVotes = 0;
      if (winnerId === myIdRef.current) sndWin();
    });
    socket.on("egg_rematch_update", ({ votes, total }: { votes: number; total: number }) => {
      gs.rematchVotes = votes; gs.rematchTotal = total;
    });

    return () => { socket.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, username, pigColor, isSolo]);

  // ── Keyboard ──────────────────────────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (["Space","ArrowUp","KeyW"].includes(e.code)) { e.preventDefault(); gs.jumpPressed = true; }
      if (e.code === "KeyR" && gs.phase === "gameover" && gs.solo) restartSolo();
    };
    const up = () => { gs.jumpPressed = false; gs.jumpConsumed = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function restartSolo() {
    gs.phase = "playing"; gs.worldY = 0; gs.vy = 0;
    gs.myState = "resting"; gs.platformLevel = 0; gs.highestLevel = 0;
    gs.camY = -H * 0.35; gs.startTime = Date.now(); gs.playStart = Date.now();
    gs.jumpPressed = false; gs.jumpConsumed = false;
    gs.x = W / 2; gs.myPlatOffsetX = 0;
  }

  // ── RAF loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    function loop() {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) { rafRef.current = requestAnimationFrame(loop); return; }

      const now     = Date.now();
      const elapsed = gs.startTime > 0 ? now - gs.startTime : 0;
      const myId    = myIdRef.current;
      const socket  = socketRef.current;

      // ── Own egg physics ────────────────────────────────────────────
      if (gs.phase === "playing") {
        if (gs.jumpPressed && !gs.jumpConsumed && gs.myState === "resting") {
          gs.myState = "jumping"; gs.vy = JUMP_SPEED; gs.jumpConsumed = true;
          sndJump();
          if (!gs.solo) socket?.emit("egg_jump", { fromLevel: gs.platformLevel });
        }
        if (!gs.jumpPressed) gs.jumpConsumed = false;

        if (gs.myState === "jumping") {
          gs.vy -= GRAVITY; gs.worldY += gs.vy;

          const nextLv  = gs.platformLevel + 1;
          const nWY     = platWY(nextLv);
          const currWY  = platWY(gs.platformLevel);
          const nCX     = platCX(nextLv, elapsed);
          // wider hitbox than platform actual width for more forgiving landing
          const halfPw  = platW(nextLv) / 2 + EGG_R * 1.0;

          // Land when falling (vy<0) and egg is anywhere between current
          // platform and next platform — full gap gives many frames for
          // the moving platform to slide under the egg
          if (gs.vy < 0 && gs.worldY <= nWY && gs.worldY >= currWY) {
            if (Math.abs(gs.x - nCX) <= halfPw) {
              gs.worldY        = nWY;
              gs.vy            = 0;
              gs.myState       = "resting";
              gs.platformLevel = nextLv;
              // remember where the egg landed relative to the platform center
              gs.myPlatOffsetX = gs.x - nCX;
              if (nextLv > gs.highestLevel) gs.highestLevel = nextLv;
              sndLand();
              if (!gs.solo) {
                socket?.emit("egg_land", { level: nextLv });
                const me = gs.players.find(p => p.id === myId);
                if (me) me.highestLevel = gs.highestLevel;
              }
            }
          }

          // Death: fell below current platform surface
          if (gs.worldY < currWY - 80) {
            gs.myState = "dead"; sndDie();
            if (gs.solo) {
              gs.phase = "gameover";
            } else {
              gs.phase = "spectating";
              socket?.emit("egg_died");
              const me = gs.players.find(p => p.id === myId);
              if (me) me.alive = false;
            }
          }
        } else if (gs.myState === "resting") {
          // move with the platform, keeping the lateral offset from landing
          gs.x     = platCX(gs.platformLevel, elapsed) + gs.myPlatOffsetX;
          gs.worldY = platWY(gs.platformLevel);
        }

        if (!gs.solo && now - gs.lastSync > SYNC_MS) {
          socket?.emit("egg_sync", { worldY: gs.worldY, vy: gs.vy, state: gs.myState });
          gs.lastSync = now;
        }
      }

      // ── Others physics ─────────────────────────────────────────────
      for (const o of gs.others.values()) {
        if (o.state === "jumping") { o.vy -= GRAVITY; o.worldY += o.vy; }
        else if (o.state === "resting") { o.x = platCX(o.platformLevel, elapsed); o.worldY = platWY(o.platformLevel); }
      }

      // ── Camera: follow highest alive ───────────────────────────────
      let highY = (gs.myState === "dead") ? -Infinity : gs.worldY;
      for (const o of gs.others.values()) if (o.state !== "dead") highY = Math.max(highY, o.worldY);
      if (highY === -Infinity) highY = gs.worldY;
      gs.camY += (highY - H * 0.65 - gs.camY) * CAM_LERP;

      // ── Highest level for zone colour ──────────────────────────────
      let visLv = gs.platformLevel;
      for (const o of gs.others.values()) visLv = Math.max(visLv, o.platformLevel);

      // ── Draw ───────────────────────────────────────────────────────
      drawBg(ctx, gs.camY, visLv);
      drawGround(ctx, gs.camY);

      const botLv = Math.max(0, Math.floor(gs.camY / PLATFORM_SPACING) - 1);
      const topLv = Math.ceil((gs.camY + H) / PLATFORM_SPACING) + 2;
      for (let lv = botLv; lv <= topLv; lv++) drawPlat(ctx, lv, elapsed, gs.camY);

      for (const o of gs.others.values())
        drawEgg(ctx, o.x, screenY(o.worldY, gs.camY) - EGG_R, EGG_COLORS[o.slot] ?? "#fff", o.username, o.state === "dead");

      if (gs.phase !== "lobby")
        drawEgg(ctx, gs.x, screenY(gs.worldY, gs.camY) - EGG_R, EGG_COLORS[gs.mySlot] ?? pigColor, username, gs.myState === "dead");

      if (gs.phase === "playing" || gs.phase === "spectating")
        drawHUD(ctx, gs.platformLevel, gs.players, myId, gs.solo);

      // ── Lobby overlay ──────────────────────────────────────────────
      if (gs.phase === "lobby") {
        ctx.fillStyle = "rgba(0,0,0,0.68)"; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#fde68a"; ctx.font = "bold 30px sans-serif"; ctx.textAlign = "center";
        ctx.fillText("🥚 Lempar Telur", W / 2, 100);
        ctx.fillStyle = "#ccc"; ctx.font = "16px sans-serif";
        ctx.fillText(`Pemain: ${gs.players.length} / 5`, W / 2, 138);
        gs.players.forEach((p, i) => {
          ctx.fillStyle = p.id === myId ? "#fde68a" : "#ccc";
          ctx.font = p.id === myId ? "bold 15px sans-serif" : "14px sans-serif";
          ctx.fillText(`${i + 1}. ${p.username}`, W / 2, 172 + i * 28);
        });
        if (gs.host === myId) {
          if (gs.players.length >= 2) {
            ctx.fillStyle = "#4ade80"; ctx.beginPath();
            ctx.roundRect(W/2-85, H-115, 170, 46, 10); ctx.fill();
            ctx.fillStyle = "#000"; ctx.font = "bold 18px sans-serif";
            ctx.fillText("▶ Mulai Game", W/2, H-86);
          } else {
            ctx.fillStyle = "#888"; ctx.font = "14px sans-serif";
            ctx.fillText("Butuh minimal 2 pemain", W/2, H-92);
          }
        } else {
          ctx.fillStyle = "#888"; ctx.font = "14px sans-serif";
          ctx.fillText("Menunggu host memulai...", W/2, H-92);
        }
      }

      // ── Spectating overlay ─────────────────────────────────────────
      if (gs.phase === "spectating") {
        ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(0, 0, W, 38);
        ctx.fillStyle = "#f87171"; ctx.font = "bold 15px sans-serif"; ctx.textAlign = "center";
        ctx.fillText("💀 Kamu gugur! Menonton pemain lain...", W/2, 24);
      }

      // ── Game over overlay ──────────────────────────────────────────
      if (gs.phase === "gameover") {
        ctx.fillStyle = "rgba(0,0,0,0.78)"; ctx.fillRect(0, 0, W, H);
        ctx.textAlign = "center";

        if (gs.solo) {
          // Solo result
          const score = calcScore(gs.highestLevel, now - gs.playStart);
          const rank  = rankTier(gs.highestLevel);
          ctx.fillStyle = "#fde68a"; ctx.font = "bold 32px sans-serif";
          ctx.fillText("🥚 Hasil Solo", W/2, 90);
          ctx.fillStyle = rank.color; ctx.font = "bold 48px sans-serif";
          ctx.fillText(rank.icon, W/2, 155);
          ctx.fillStyle = rank.color; ctx.font = "bold 22px sans-serif";
          ctx.fillText(rank.label, W/2, 190);
          ctx.fillStyle = "#fff"; ctx.font = "16px sans-serif";
          ctx.fillText(`Platform tertinggi: ${gs.highestLevel}`, W/2, 225);
          ctx.fillStyle = "#fde68a"; ctx.font = "bold 20px sans-serif";
          ctx.fillText(`Skor: ${score}`, W/2, 255);

          // Rank ladder preview
          const tiers = [
            { icon: "🥚", lbl: "Pemula",  min: 0 },
            { icon: "🐣", lbl: "Biasa",   min: 5 },
            { icon: "⭐", lbl: "Bagus",   min: 10 },
            { icon: "🔥", lbl: "Mahir",   min: 25 },
            { icon: "💎", lbl: "Ahli",    min: 50 },
            { icon: "👑", lbl: "Legenda", min: 100 },
          ];
          ctx.font = "12px sans-serif";
          tiers.forEach((t, i) => {
            const active = gs.highestLevel >= t.min && (i === tiers.length - 1 || gs.highestLevel < tiers[i+1].min);
            ctx.fillStyle = active ? "#fde68a" : "rgba(255,255,255,0.35)";
            ctx.fillText(`${t.icon} ${t.lbl} (${t.min}+)`, W/2, 290 + i * 18);
          });

          // Restart
          ctx.fillStyle = "#4ade80"; ctx.beginPath();
          ctx.roundRect(W/2-90, H-108, 180, 44, 10); ctx.fill();
          ctx.fillStyle = "#000"; ctx.font = "bold 17px sans-serif";
          ctx.fillText("🔄 Main Lagi (R)", W/2, H-80);
        } else {
          // Multiplayer result
          ctx.fillStyle = "#fde68a"; ctx.font = "bold 34px sans-serif";
          ctx.fillText("🏆 Game Over!", W/2, 110);
          ctx.fillStyle = "#fff"; ctx.font = "20px sans-serif";
          ctx.fillText(`Pemenang: ${gs.winnerName}`, W/2, 152);

          const sorted = [...gs.players].sort((a, b) => b.highestLevel - a.highestLevel);
          sorted.forEach((p, i) => {
            const medal  = PLACE_MEDALS[i] ?? "";
            const rank   = rankTier(p.highestLevel);
            const score  = calcScore(p.highestLevel, 0);
            const isWinner = p.id === gs.winnerId;
            ctx.fillStyle = isWinner ? "#fde68a" : (p.id === myId ? "#a5f3fc" : "#ccc");
            ctx.font = isWinner ? "bold 16px sans-serif" : "14px sans-serif";
            ctx.fillText(
              `${medal} ${p.username}  ${rank.icon}${rank.label}  L${p.highestLevel}  ${score}pts`,
              W/2, 192 + i * 30
            );
          });

          const votes = gs.rematchVotes, total = gs.rematchTotal || gs.players.length;
          ctx.fillStyle = "#86efac"; ctx.beginPath();
          ctx.roundRect(W/2-95, H-108, 190, 44, 10); ctx.fill();
          ctx.fillStyle = "#000"; ctx.font = "bold 17px sans-serif";
          ctx.fillText(`🔄 Main Lagi (${votes}/${total})`, W/2, H-80);
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Click / tap handler ───────────────────────────────────────────────
  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (W / rect.width);
    const cy = (e.clientY - rect.top)  * (H / rect.height);

    if (gs.phase === "lobby") {
      if (gs.host === myIdRef.current && gs.players.length >= 2)
        if (cx >= W/2-85 && cx <= W/2+85 && cy >= H-115 && cy <= H-69)
          socketRef.current?.emit("egg_start");
    } else if (gs.phase === "playing") {
      gs.jumpPressed = true;
      setTimeout(() => { gs.jumpPressed = false; gs.jumpConsumed = false; }, 100);
    } else if (gs.phase === "gameover") {
      if (gs.solo) {
        if (cx >= W/2-90 && cx <= W/2+90 && cy >= H-108 && cy <= H-64) restartSolo();
      } else {
        if (cx >= W/2-95 && cx <= W/2+95 && cy >= H-108 && cy <= H-64)
          socketRef.current?.emit("egg_rematch");
      }
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <canvas
        ref={canvasRef} width={W} height={H} onClick={handleClick}
        className="rounded-xl shadow-2xl border-2 border-white/20 cursor-pointer max-w-full"
        style={{ imageRendering: "pixelated" }}
      />
      <p className="text-white/60 text-xs">
        Tekan <kbd className="bg-white/20 px-1 rounded">Spasi</kbd> / <kbd className="bg-white/20 px-1 rounded">↑</kbd> atau tap untuk loncat
        {isSolo && <> · <kbd className="bg-white/20 px-1 rounded">R</kbd> untuk restart</>}
      </p>
    </div>
  );
}
