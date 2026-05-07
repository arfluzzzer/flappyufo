"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

interface PlayerState {
  id: string;
  username: string;
  y: number;
  score: number;
  alive: boolean;
  powered: boolean;
  bigMode: boolean;
  pigColor?: string;
  slot?: number;
}

interface GameProps {
  username: string;
  userId: number;
  roomId: string;
  solo: boolean;
  pigColor?: string;
  initialSpeed?: number;
}

const CONFIG = {
  gapSize: 230,
  baseSpeed: 3,
  width: 800,
  height: 600,
};

const PIG_COLOR_MAP: Record<
  string,
  { body: [string, string]; stroke: string }
> = {
  pink: { body: ["#ffc8d8", "#ffb3c1"], stroke: "#e8829a" },
  blue: { body: ["#c0d8ff", "#a8c8ff"], stroke: "#4a82e8" },
  purple: { body: ["#dcc0ff", "#cca8ff"], stroke: "#9050e8" },
  orange: { body: ["#ffe0b0", "#ffd090"], stroke: "#e88030" },
  green: { body: ["#b8f0c8", "#a0e8b0"], stroke: "#30c870" },
  yellow: { body: ["#fff4b0", "#ffee90"], stroke: "#d8c030" },
  red: { body: ["#ffc0b8", "#ffb0a0"], stroke: "#e83020" },
  teal: { body: ["#b0eee8", "#98e8e0"], stroke: "#30a8a0" },
  white: { body: ["#f8f8f8", "#e8e8e8"], stroke: "#b0b0b0" },
  brown: { body: ["#ddc0a0", "#cdb090"], stroke: "#906040" },
};

const PIG_COLOR_HEX: Record<string, string> = {
  pink: "#ffc8d8",
  blue: "#a8d4ff",
  purple: "#d0a8ff",
  orange: "#ffd0a0",
  green: "#a8f0c0",
  yellow: "#fff0a0",
  red: "#ffb0a8",
  teal: "#a0e8e0",
  white: "#f4f4f4",
  brown: "#d4b090",
};

// Seeded pseudo-random number generator (Mulberry32)
// Same seed → identical sequence → identical pipes for all players
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function Game({
  username,
  userId,
  roomId,
  solo,
  pigColor = "pink",
  initialSpeed,
}: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef({
    started: false,
    over: false,
    score: 0,
    birdY: 200,
    birdVelocity: 0,
    birdSize: { w: 54, h: 46 },
    isPowered: false,
    bigMode: false,
    bigTimer: null as ReturnType<typeof setTimeout> | null,
    powerTimer: null as ReturnType<typeof setTimeout> | null,
    pipes: [] as {
      x: number;
      topH: number;
      bottomH: number;
      passed: boolean;
      crushed: boolean;
    }[],
    coins: [] as { x: number; y: number; collected: boolean; animT: number }[],
    mushrooms: [] as { x: number; y: number; collected: boolean }[],
    pipeSpeed: CONFIG.baseSpeed,
    pipesWiggling: false,
    pipesPassedCount: 0,
    gameSeed: 0,
    initialSpeed: 3,
    rng: null as (() => number) | null,
    frame: 0,
    flapAngle: 0,
    gameLoop: null as ReturnType<typeof setInterval> | null,
    countdownIv: null as ReturnType<typeof setInterval> | null,
    countdownDrawIv: null as ReturnType<typeof setInterval> | null,
    animLoop: null as ReturnType<typeof setInterval> | null,
    countdownVal: 0,
    countdownActive: false,
    opponents: new Map<string, PlayerState>(),
    winnerName: "",
    myWon: false,
    showResult: false,
    resultScores: [] as { username: string; score: number }[],
    deathParticles: [] as {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      color: string;
    }[],
    winParticles: [] as {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      color: string;
      size: number;
    }[],
  });
  const socketRef = useRef<Socket | null>(null);
  const [uiScore, setUiScore] = useState(0);
  const [gamePhase, setGamePhase] = useState<
    "waiting" | "countdown" | "playing" | "dead" | "result"
  >("waiting");
  const [countdown, setCountdown] = useState(3);
  const [targetScore, setTargetScore] = useState<number | null>(null);
  const [opponentName, setOpponentName] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [roomPlayers, setRoomPlayers] = useState<PlayerState[]>([]);
  const [roomSpeed, setRoomSpeed] = useState(initialSpeed || 3);
  const [resultData, setResultData] = useState<{
    winner: string;
    myWon: boolean;
    scores: { username: string; score: number }[];
  } | null>(null);

  // Audio
  const audioCtxRef = useRef<AudioContext | null>(null);
  function getAudio() {
    if (!audioCtxRef.current)
      audioCtxRef.current = new (
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext
      )();
    return audioCtxRef.current;
  }
  function playOink() {
    try {
      const ctx = getAudio();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(320, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(170, ctx.currentTime + 0.15);
      osc.frequency.exponentialRampToValueAtTime(260, ctx.currentTime + 0.32);
      g.gain.setValueAtTime(0.35, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
    } catch {
      /* ignore */
    }
  }
  function playPowerUp() {
    try {
      const ctx = getAudio();
      [400, 520, 660, 800].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.connect(g);
        g.connect(ctx.destination);
        osc.type = "square";
        osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.09;
        g.gain.setValueAtTime(0.15, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.start(t);
        osc.stop(t + 0.18);
      });
    } catch {
      /* ignore */
    }
  }
  function playCrush() {
    try {
      const ctx = getAudio();
      const buf = ctx.createBuffer(
        1,
        Math.floor(ctx.sampleRate * 0.18),
        ctx.sampleRate,
      );
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++)
        data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      src.buffer = buf;
      src.connect(g);
      g.connect(ctx.destination);
      g.gain.value = 0.3;
      src.start();
    } catch {
      /* ignore */
    }
  }
  function playWin() {
    try {
      const ctx = getAudio();
      [523, 659, 784, 1047].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.connect(g);
        g.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.15;
        g.gain.setValueAtTime(0.3, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        osc.start(t);
        osc.stop(t + 0.4);
      });
    } catch {
      /* ignore */
    }
  }
  function playLose() {
    try {
      const ctx = getAudio();
      [400, 350, 300, 200].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.connect(g);
        g.connect(ctx.destination);
        osc.type = "sawtooth";
        osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.15;
        g.gain.setValueAtTime(0.2, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        osc.start(t);
        osc.stop(t + 0.3);
      });
    } catch {
      /* ignore */
    }
  }

  // ── SPAWN helpers ─────────────────────────────────────
  function spawnCoins(pipeX: number, topH: number) {
    const g = gameRef.current;
    const gapCY = topH + CONFIG.gapSize / 2;
    const cy = CONFIG.height - gapCY - 14;
    const offsets = [-90, 55, 210].filter(
      () => (g.rng?.() ?? Math.random()) > 0.35,
    );
    if (!offsets.length) offsets.push(55);
    offsets.forEach((o) => {
      gameRef.current.coins.push({
        x: pipeX + o,
        y: cy,
        collected: false,
        animT: 0,
      });
    });
  }
  function spawnMushroom(pipeX: number, topH: number) {
    const gapCY = topH + CONFIG.gapSize / 2;
    const cy = CONFIG.height - gapCY - 18;
    gameRef.current.mushrooms.push({ x: pipeX + 130, y: cy, collected: false });
  }

  function makePipe(x: number) {
    const g = gameRef.current;
    const minH = 60,
      maxH = CONFIG.height - CONFIG.gapSize - minH;
    const topH = (g.rng?.() ?? Math.random()) * (maxH - minH) + minH;
    const bottomH = CONFIG.height - topH - CONFIG.gapSize;
    g.pipes.push({
      x,
      topH,
      bottomH,
      passed: false,
      crushed: false,
    });
    spawnCoins(x, topH);
    if ((g.rng?.() ?? Math.random()) < 0.3 && !g.isPowered)
      spawnMushroom(x, topH);
  }

  function initPipes() {
    const g = gameRef.current;
    g.pipes = [];
    g.coins = [];
    g.mushrooms = [];
    for (let i = 0; i < 5; i++) makePipe(800 + i * 600);
  }

  // Activate mushroom — grants 5 seconds of immunity (pig grows, all pipe hits ignored)
  function activateMushroom() {
    const g = gameRef.current;
    g.bigMode = true;
    g.birdSize = { w: 72, h: 62 };
    playPowerUp();
    // Clear any existing timer then set 5-second immunity
    if (g.bigTimer) clearTimeout(g.bigTimer);
    g.bigTimer = setTimeout(() => {
      g.bigMode = false;
      g.birdSize = { w: 54, h: 46 };
      g.bigTimer = null;
    }, 5000);
  }

  function activatePower() {
    const g = gameRef.current;
    g.isPowered = true;
    if (g.powerTimer) clearTimeout(g.powerTimer);
    g.powerTimer = setTimeout(() => {
      g.isPowered = false;
    }, 7000);
  }

  // Spawn death particles
  function spawnDeathParticles(x: number, y: number) {
    const colors = ["#ff6347", "#ff4500", "#ffd700", "#ff69b4", "#ff1493"];
    for (let i = 0; i < 24; i++) {
      const angle = (Math.PI * 2 * i) / 24 + Math.random() * 0.3;
      const speed = 3 + Math.random() * 5;
      gameRef.current.deathParticles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
  }

  function spawnWinParticles() {
    const colors = [
      "#ffd700",
      "#ff69b4",
      "#00ff88",
      "#00cfff",
      "#ffffff",
      "#ff9900",
    ];
    for (let i = 0; i < 60; i++) {
      gameRef.current.winParticles.push({
        x: Math.random() * CONFIG.width,
        y: Math.random() * CONFIG.height * 0.5,
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * 3 + 1,
        life: 1,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 4 + Math.random() * 8,
      });
    }
  }

  // ── DRAW ──────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const g = gameRef.current;
    const { width: W, height: H } = CONFIG;

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#ffcbf2");
    bg.addColorStop(0.4, "#ffd6e0");
    bg.addColorStop(1, "#ffecd2");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Clouds
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    const cf = (g.frame * 0.3) % (W + 150);
    [
      [W + 80 - cf, 60, 80, 40],
      [W + 200 - cf, 120, 100, 50],
      [W + 350 - cf, 180, 70, 35],
    ].forEach(([cx, cy, cw, ch]) => {
      const rx = ((cx - -150) % (W + 150)) - 150;
      ctx.beginPath();
      ctx.ellipse(rx, cy, cw / 2, ch / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(rx - 20, cy - 10, cw * 0.3, ch * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(rx + 25, cy - 8, cw * 0.35, ch * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // Pipes
    g.pipes.forEach((pipe) => {
      const wiggle = g.pipesWiggling ? Math.sin(g.frame * 0.3) * 5 : 0;
      const px = pipe.x + wiggle;
      if (pipe.crushed) {
        ctx.globalAlpha = 0.4;
        ctx.filter = "brightness(3) saturate(0)";
      }
      // Pipe color
      const pGrad = ctx.createLinearGradient(px, 0, px + 60, 0);
      pGrad.addColorStop(0, "#a0522d");
      pGrad.addColorStop(0.5, "#cd853f");
      pGrad.addColorStop(1, "#a0522d");
      ctx.fillStyle = pGrad;
      ctx.strokeStyle = "#7a3e1e";
      ctx.lineWidth = 3;

      // Top pipe
      ctx.fillRect(px, 0, 60, pipe.topH);
      ctx.strokeRect(px, 0, 60, pipe.topH);
      ctx.fillRect(px - 5, pipe.topH - 20, 70, 20);
      ctx.strokeRect(px - 5, pipe.topH - 20, 70, 20);

      // Bottom pipe
      const by = H - pipe.bottomH;
      ctx.fillRect(px, by, 60, pipe.bottomH);
      ctx.strokeRect(px, by, 60, pipe.bottomH);
      ctx.fillRect(px - 5, by, 70, 20);
      ctx.strokeRect(px - 5, by, 70, 20);

      ctx.globalAlpha = 1;
      ctx.filter = "none";
    });

    // Coins
    g.coins.forEach((coin) => {
      if (coin.collected) return;
      coin.animT += 0.06;
      const scaleX = Math.abs(Math.cos(coin.animT));
      ctx.save();
      ctx.translate(coin.x + 14, coin.y + 14);
      ctx.scale(scaleX, 1);
      const cGrad = ctx.createRadialGradient(-4, -4, 2, 0, 0, 14);
      cGrad.addColorStop(0, "#ffe066");
      cGrad.addColorStop(0.6, "#ffd700");
      cGrad.addColorStop(1, "#b8860b");
      ctx.fillStyle = cGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#b8860b";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    });

    // Mushrooms
    g.mushrooms.forEach((m) => {
      if (m.collected) return;
      const bob = Math.sin(g.frame * 0.08) * 6;
      ctx.save();
      ctx.translate(m.x, m.y + bob);
      // Cap
      ctx.fillStyle = "#e03030";
      ctx.beginPath();
      ctx.ellipse(18, 12, 18, 13, 0, 0, Math.PI * 2);
      ctx.fill();
      // Spots
      ctx.fillStyle = "white";
      [
        [8, 6, 3],
        [22, 4, 4],
        [16, 10, 3],
      ].forEach(([sx, sy, sr]) => {
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();
      });
      // Stem
      ctx.fillStyle = "#ffecd2";
      ctx.strokeStyle = "#d4a574";
      ctx.lineWidth = 1.5;
      ctx.fillRect(7, 22, 22, 14);
      ctx.strokeRect(7, 22, 22, 14);
      ctx.restore();
    });

    // Opponents — clustered near player (each 80px to the right), so they share the same game space
    let opIdx = 0;
    g.opponents.forEach((op) => {
      const opW = op.bigMode ? 72 : 54;
      const opH = op.bigMode ? 62 : 46;
      const opX = 100 + 130 + opIdx * 80;
      const opY = H - op.y - opH;
      opIdx++;

      drawPig(
        ctx,
        opX,
        opY,
        opW,
        opH,
        op.powered,
        op.bigMode,
        g.frame,
        op.pigColor || "pink",
      );

      if (!op.alive) {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = "#000";
        ctx.fillRect(opX, opY, opW, opH);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#ff4444";
        ctx.font = "bold 11px Arial";
        ctx.textAlign = "center";
        ctx.fillText("💀 " + op.username, opX + opW / 2, opY - 6);
      } else {
        ctx.fillStyle = "#fff";
        ctx.font = "bold 11px Arial";
        ctx.textAlign = "center";
        ctx.fillText(op.username, opX + opW / 2, opY - 6);
      }

      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.beginPath();
      ctx.roundRect(opX, opY + opH + 2, opW, 16, 4);
      ctx.fill();
      ctx.fillStyle = "#ffd700";
      ctx.font = "bold 11px Arial";
      ctx.textAlign = "center";
      ctx.fillText(`${op.score}`, opX + opW / 2, opY + opH + 13);
    });

    // Player pig
    const { w: bW, h: bH } = g.birdSize;
    const bx = 100;
    const by2 = H - g.birdY - bH;
    drawPig(ctx, bx, by2, bW, bH, g.isPowered, g.bigMode, g.frame, pigColor);

    // Player label
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px Arial";
    ctx.textAlign = "center";
    ctx.fillText(username, bx + bW / 2, by2 - 6);

    // Death particles
    g.deathParticles = g.deathParticles.filter((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.2;
      p.life -= 0.025;
      if (p.life <= 0) return false;
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return true;
    });

    // Win particles
    g.winParticles = g.winParticles.filter((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.008;
      if (p.life <= 0) return false;
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
      ctx.globalAlpha = 1;
      return true;
    });

    // Ground
    ctx.fillStyle = "#8b4513";
    ctx.fillRect(0, H - 20, W, 20);
    ctx.fillStyle = "#654321";
    ctx.fillRect(0, H - 20, W, 4);

    // Score HUD
    ctx.fillStyle = "white";
    ctx.font = "bold 36px Arial";
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 8;
    ctx.fillText(`Score: ${g.score}`, W / 2, 55);
    ctx.shadowBlur = 0;

    // Power indicator
    if (g.bigMode) {
      ctx.fillStyle = "#ff69b4";
      ctx.font = "bold 16px Arial";
      ctx.textAlign = "center";
      ctx.fillText("🛡️ NYAWA EKSTRA! (tahan 1 pipa)", W / 2, 85);
    }
    if (g.isPowered) {
      ctx.fillStyle = "#ffd700";
      ctx.font = "bold 16px Arial";
      ctx.textAlign = "center";
      ctx.fillText("⚡ POWER UP!", W / 2, g.bigMode ? 105 : 85);
    }

    // Solo countdown overlay (multiplayer uses HTML overlay instead)
    if (solo && g.countdownActive && g.countdownVal > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ffd700";
      ctx.font = "bold 140px Arial";
      ctx.textAlign = "center";
      ctx.shadowColor = "#ff6347";
      ctx.shadowBlur = 30;
      ctx.fillText(String(g.countdownVal), W / 2, H / 2 + 50);
      ctx.shadowBlur = 0;
    }

    g.frame++;
  }, [username, solo]);

  function drawPig(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    powered: boolean,
    bigMode: boolean,
    frame: number,
    colorId: string = "pink",
  ) {
    const palette = PIG_COLOR_MAP[colorId] || PIG_COLOR_MAP["pink"];
    const [bodyLight, bodyDark] = palette.body;
    const strokeColor = palette.stroke;

    ctx.save();
    if (powered) {
      ctx.shadowColor = "#ffd700";
      ctx.shadowBlur = 20;
    }
    if (bigMode) {
      ctx.shadowColor = "#ff69b4";
      ctx.shadowBlur = 15;
    }

    // Body
    const bodyGrad = ctx.createRadialGradient(
      x + w * 0.4,
      y + h * 0.4,
      2,
      x + w / 2,
      y + h / 2,
      w * 0.7,
    );
    bodyGrad.addColorStop(0, bodyLight);
    bodyGrad.addColorStop(1, bodyDark);
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Wing
    ctx.fillStyle = bodyLight;
    ctx.beginPath();
    ctx.ellipse(x + 4, y + h / 2 + 5, 10, 7, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // Ear
    ctx.fillStyle = strokeColor;
    ctx.beginPath();
    ctx.ellipse(x + w * 0.25, y + 5, 7, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + w * 0.55, y + 5, 7, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // Snout
    ctx.fillStyle = strokeColor;
    ctx.beginPath();
    ctx.ellipse(x + w - 8, y + h * 0.55, 11, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(130,40,60,0.3)";
    ctx.beginPath();
    ctx.arc(x + w - 13, y + h * 0.58, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + w - 4, y + h * 0.58, 3, 0, Math.PI * 2);
    ctx.fill();

    // Eye
    ctx.fillStyle = "#2d2d2d";
    ctx.beginPath();
    ctx.arc(x + w * 0.62, y + h * 0.38, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(x + w * 0.63, y + h * 0.36, 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Flap animation
    if (powered) {
      const flapY = Math.sin(frame * 0.3) * 4;
      ctx.strokeStyle = "#ffd700";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.3, y + h * 0.5);
      ctx.lineTo(x - 12, y + h * 0.3 + flapY);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ── GAME TICK ─────────────────────────────────────────
  const tick = useCallback(() => {
    const g = gameRef.current;
    if (!g.started || g.over) return;

    const gravity = -0.5;
    const jumpStrength = 9;

    g.birdVelocity += gravity;
    g.birdY += g.birdVelocity;

    if (g.birdY <= 0) {
      endGame();
      return;
    }
    if (g.birdY >= CONFIG.height - 20 - g.birdSize.h) {
      g.birdY = CONFIG.height - 20 - g.birdSize.h;
      g.birdVelocity = 0;
    }

    // Pipes
    const { w: bW, h: bH } = g.birdSize;
    const birdLeft = 100,
      birdRight = 100 + bW;
    const birdTop = CONFIG.height - g.birdY - bH;
    const birdBottom = CONFIG.height - g.birdY;

    g.pipes.forEach((pipe) => {
      pipe.x -= g.pipeSpeed;
      const px = pipe.x,
        pr = pipe.x + 60;

      if (birdRight > px + 5 && birdLeft < pr - 5) {
        const inTop = birdTop < pipe.topH;
        const inBottom = birdBottom > CONFIG.height - pipe.bottomH;
        if (inTop || inBottom) {
          if (g.isPowered) {
            // Coin power: unlimited pipe crushing while active
            if (!pipe.crushed) {
              pipe.crushed = true;
              playCrush();
              setTimeout(() => {
                pipe.crushed = false;
              }, 400);
            }
          } else if (g.bigMode) {
            // Mushroom immunity: ignore all hits for 1 second, no crush effect
          } else if (!pipe.crushed) {
            endGame();
            return;
          }
        }
      } else {
        pipe.crushed = false;
      }

      if (!pipe.passed && pipe.x < 80) {
        pipe.passed = true;
        g.score++;
        g.pipesPassedCount++;
        setUiScore(g.score);
        if (g.pipesPassedCount >= 20 && !g.pipesWiggling)
          g.pipesWiggling = true;
        if (g.pipesPassedCount % 5 === 0) g.pipeSpeed += 0.3;
      }
    });

    if (g.pipes.length > 0 && g.pipes[0].x < -100) {
      g.pipes.shift();
      makePipe(g.pipes[g.pipes.length - 1].x + 600);
    }

    // Coins
    g.coins = g.coins.filter((coin) => {
      if (coin.collected) return false;
      coin.x -= g.pipeSpeed;
      if (coin.x < -40) return false;
      const cx = coin.x + 14,
        cy2 = coin.y + 14;
      const bCx = 100 + bW / 2,
        bCy = CONFIG.height - g.birdY - bH / 2;
      if (
        Math.abs(cx - bCx) < bW / 2 + 14 &&
        Math.abs(cy2 - bCy) < bH / 2 + 14
      ) {
        coin.collected = true;
        g.score++;
        setUiScore(g.score);
        playOink();
        return false;
      }
      return true;
    });

    // Mushrooms
    g.mushrooms = g.mushrooms.filter((m) => {
      m.x -= g.pipeSpeed;
      if (m.x < -60) return false;
      const mx = m.x + 18,
        my = m.y + 18;
      const bCx = 100 + bW / 2,
        bCy = CONFIG.height - g.birdY - bH / 2;
      if (
        Math.abs(mx - bCx) < bW / 2 + 18 &&
        Math.abs(my - bCy) < bH / 2 + 18
      ) {
        m.collected = true;
        activateMushroom();
        return false;
      }
      return true;
    });

    // Sync to multiplayer
    if (!solo && socketRef.current) {
      socketRef.current.emit("player_update", {
        y: g.birdY,
        score: g.score,
        alive: true,
        powered: g.isPowered,
        bigMode: g.bigMode,
      });
    }

    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw, solo]);

  function endGame() {
    const g = gameRef.current;
    if (g.over) return;
    g.over = true;
    g.started = false;
    if (g.gameLoop) clearInterval(g.gameLoop);
    if (g.powerTimer) clearTimeout(g.powerTimer);
    if (g.bigTimer) clearTimeout(g.bigTimer);
    g.isPowered = false;
    g.bigMode = false;
    g.birdSize = { w: 54, h: 46 };

    // Spawn death particles at pig position
    const bx = 100 + g.birdSize.w / 2;
    const by2 = CONFIG.height - g.birdY - g.birdSize.h / 2;
    spawnDeathParticles(bx, by2);
    playLose();

    // Save score
    fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, score: g.score }),
    });

    if (solo) {
      setGamePhase("dead");
      // Animate particles then show result
      g.animLoop = setInterval(() => draw(), 20);
      setTimeout(() => {
        if (g.animLoop) {
          clearInterval(g.animLoop);
          g.animLoop = null;
        }
        setResultData({
          winner: "",
          myWon: false,
          scores: [{ username, score: g.score }],
        });
        setGamePhase("result");
        draw();
      }, 1500);
    } else if (socketRef.current) {
      socketRef.current.emit("player_died", { score: g.score });
      // Animate particles
      g.animLoop = setInterval(() => draw(), 20);
      setTimeout(() => {
        if (g.animLoop) {
          clearInterval(g.animLoop);
          g.animLoop = null;
        }
      }, 1500);
      setGamePhase("dead");
    }
  }

  function jump() {
    const g = gameRef.current;
    if (g.countdownActive) return;
    if (g.over || !g.started) return;
    g.birdVelocity = 9;
  }

  function startGame() {
    const g = gameRef.current;
    g.over = false;
    g.score = 0;
    g.birdY = 200;
    g.birdVelocity = 0;
    g.isPowered = false;
    g.bigMode = false;
    if (g.bigTimer) {
      clearTimeout(g.bigTimer);
      g.bigTimer = null;
    }
    if (g.powerTimer) {
      clearTimeout(g.powerTimer);
      g.powerTimer = null;
    }
    g.birdSize = { w: 54, h: 46 };
    g.pipesWiggling = false;
    g.pipeSpeed = g.initialSpeed; // use stored initialSpeed, not global CONFIG
    g.pipesPassedCount = 0;
    // (Re-)initialize seeded RNG so all players get identical pipe sequence
    if (g.gameSeed) g.rng = mulberry32(g.gameSeed);
    g.deathParticles = [];
    g.winParticles = [];
    setUiScore(0);
    initPipes();
    g.started = true;
    if (g.gameLoop) clearInterval(g.gameLoop);
    g.gameLoop = setInterval(tick, 20);
    setGamePhase("playing");
  }

  function startCountdown(secs: number, onDone: () => void) {
    const g = gameRef.current;
    // Clear any previously running countdown (prevents double-run from StrictMode)
    if (g.countdownIv) {
      clearInterval(g.countdownIv);
      g.countdownIv = null;
    }
    if (g.countdownDrawIv) {
      clearInterval(g.countdownDrawIv);
      g.countdownDrawIv = null;
    }
    if (g.animLoop) {
      clearInterval(g.animLoop);
      g.animLoop = null;
    }
    // If no countdown time, start immediately
    if (secs <= 0) {
      g.countdownActive = false;
      onDone();
      return;
    }
    g.countdownActive = true;
    g.countdownVal = secs;
    setCountdown(secs);
    setGamePhase("countdown");
    g.countdownIv = setInterval(() => {
      g.countdownVal--;
      setCountdown(g.countdownVal);
      if (g.countdownVal <= 0) {
        if (g.countdownIv) clearInterval(g.countdownIv);
        g.countdownIv = null;
        g.countdownActive = false;
        onDone();
      }
    }, 1000);
    // keep drawing during countdown
    g.countdownDrawIv = setInterval(() => draw(), 50);
    setTimeout(
      () => {
        if (g.countdownDrawIv) clearInterval(g.countdownDrawIv);
        g.countdownDrawIv = null;
      },
      secs * 1000 + 200,
    );
  }

  // ── SOCKET ────────────────────────────────────────────
  useEffect(() => {
    // Guard against React StrictMode double-invoke:
    // cancelled flag prevents the async fetch callback from creating a socket
    // after the cleanup has already run.
    let cancelled = false;

    // Wake up the socket.io server endpoint first
    fetch("/api/socketio").finally(() => {
      if (cancelled) return; // cleanup already ran — abort

      const socket = io({
        path: "/api/socketio",
        transports: ["websocket", "polling"],
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        if (!solo)
          socket.emit("join_room", {
            roomId,
            username,
            pigColor,
            speed: initialSpeed || CONFIG.baseSpeed,
          });
      });

      socket.on(
        "room_state",
        ({
          players,
          host,
          speed,
        }: {
          players: PlayerState[];
          host?: string;
          speed?: number;
        }) => {
          setRoomPlayers(players);
          setIsHost(socket.id === host);
          if (speed !== undefined) {
            setRoomSpeed(speed);
            gameRef.current.initialSpeed = speed;
          }
          // Replace opponents map cleanly to avoid stale entries
          gameRef.current.opponents.clear();
          players.forEach((p) => {
            if (p.id !== socket.id) gameRef.current.opponents.set(p.id, p);
          });
        },
      );

      socket.on("player_joined", (p: PlayerState) => {
        // player_joined is now supplementary; room_state broadcast handles the full list
        gameRef.current.opponents.set(p.id, p);
        setOpponentName(p.username);
      });

      socket.on(
        "game_start",
        ({
          countdown: cd,
          seed,
          speed,
        }: {
          countdown: number;
          seed?: number;
          speed?: number;
        }) => {
          if (seed !== undefined) gameRef.current.gameSeed = seed;
          if (speed !== undefined) {
            gameRef.current.initialSpeed = speed; // store per-game, not global
          }
          // Ignore if already playing (duplicate event guard)
          if (gameRef.current.started && !gameRef.current.over) return;
          startCountdown(cd, startGame);
        },
      );

      socket.on("opponent_update", (data: PlayerState) => {
        const op = gameRef.current.opponents.get(data.id);
        if (op) Object.assign(op, data);
      });

      socket.on("player_died", ({ id }: { id: string }) => {
        const op = gameRef.current.opponents.get(id);
        if (op) op.alive = false;
      });

      socket.on("player_left", ({ id }: { id: string }) => {
        gameRef.current.opponents.delete(id);
        setRoomPlayers((prev) => prev.filter((p) => p.id !== id));
      });

      // Room reset after game_over_result (server resets after 5s)
      socket.on(
        "room_reset",
        ({
          players,
          host,
          speed,
        }: {
          players: PlayerState[];
          host: string;
          speed?: number;
        }) => {
          setRoomPlayers(players);
          setIsHost(socket.id === host);
          if (speed !== undefined) setRoomSpeed(speed);
          gameRef.current.opponents.clear();
          players.forEach((p) => {
            if (p.id !== socket.id) gameRef.current.opponents.set(p.id, p);
          });
          setGamePhase("waiting");
          setResultData(null);
        },
      );

      socket.on("last_survivor", ({ targetScore }: { targetScore: number }) => {
        setTargetScore(targetScore);
      });

      socket.on(
        "game_over_result",
        ({
          winnerId,
          winnerName,
          scores,
        }: {
          winnerId: string;
          winnerName: string;
          scores: { id: string; username: string; score: number }[];
        }) => {
          const myWon = winnerId === socket.id;
          setTargetScore(null);

          // All players are dead at this point — no need to force-stop anyone
          if (myWon) {
            playWin();
            spawnWinParticles();
          }
          // Dead players already heard lose sound in endGame()

          const animLoop = setInterval(() => draw(), 20);
          setTimeout(() => {
            clearInterval(animLoop);
            setResultData({
              winner: winnerName,
              myWon,
              scores: scores.map((s) => ({
                username: s.username,
                score: s.score,
              })),
            });
            setGamePhase("result");
            draw();
          }, 2000);
        },
      );
    });

    return () => {
      cancelled = true; // block pending fetch callback from creating socket
      socketRef.current?.disconnect();
      socketRef.current = null; // reset so next mount starts fresh
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Solo: apply initialSpeed then start
  useEffect(() => {
    if (solo) {
      gameRef.current.initialSpeed = initialSpeed || 3;
      startCountdown(3, startGame);
    }
    return () => {
      // Cleanup all intervals when component unmounts (handles React StrictMode double-invoke)
      const g = gameRef.current;
      if (g.gameLoop) {
        clearInterval(g.gameLoop);
        g.gameLoop = null;
      }
      if (g.countdownIv) {
        clearInterval(g.countdownIv);
        g.countdownIv = null;
      }
      if (g.countdownDrawIv) {
        clearInterval(g.countdownDrawIv);
        g.countdownDrawIv = null;
      }
      if (g.animLoop) {
        clearInterval(g.animLoop);
        g.animLoop = null;
      }
      g.started = false;
      g.over = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solo]);

  // Input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        jump();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draw loop when not in game loop
  useEffect(() => {
    const iv = setInterval(() => {
      if (!gameRef.current.started) draw();
    }, 50);
    return () => clearInterval(iv);
  }, [draw]);

  function handleRestart() {
    const g = gameRef.current;
    g.opponents.clear();
    g.deathParticles = [];
    g.winParticles = [];
    setResultData(null);
    if (solo) {
      startCountdown(3, startGame);
    } else {
      // Go back to lobby so players can create/join a fresh room
      window.location.href = "/lobby";
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative"
        style={{ width: CONFIG.width, height: CONFIG.height }}
      >
        <canvas
          ref={canvasRef}
          width={CONFIG.width}
          height={CONFIG.height}
          className="rounded-xl shadow-2xl cursor-pointer"
          style={{ border: "3px solid #e8829a" }}
          onClick={jump}
          onTouchStart={(e) => {
            e.preventDefault();
            jump();
          }}
        />

        {/* Waiting for opponent / waiting room */}
        {gamePhase === "waiting" && !solo && (
          <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-black/60 p-4">
            <div className="text-4xl mb-2">🐷</div>
            <h2 className="text-white text-2xl font-bold mb-1">Ruang Tunggu</h2>
            <p className="text-white/60 text-sm mb-4 font-mono">
              Room: <span className="text-yellow-300 font-bold">{roomId}</span>
            </p>

            {/* Player list */}
            <div className="bg-white/10 rounded-xl p-3 w-72 mb-4 max-h-64 overflow-y-auto">
              {roomPlayers.length === 0 ? (
                <p className="text-white/40 text-xs text-center py-2">
                  Menghubungkan...
                </p>
              ) : (
                roomPlayers
                  .slice()
                  .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
                  .map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-2 py-2 border-b border-white/10 last:border-0"
                    >
                      <span
                        className="inline-block w-6 h-6 rounded-full border-2 border-white/40 text-center text-xs leading-5"
                        style={{
                          backgroundColor: PIG_COLOR_HEX[p.pigColor || "pink"],
                        }}
                      >
                        🐷
                      </span>
                      <span className="text-white font-semibold flex-1 truncate">
                        {p.username}
                      </span>
                      {(p.slot ?? 99) === 0 && (
                        <span className="text-yellow-300 text-xs font-bold bg-yellow-300/20 px-1.5 py-0.5 rounded">
                          HOST
                        </span>
                      )}
                    </div>
                  ))
              )}
              {roomPlayers.length > 0 && roomPlayers.length < 2 && (
                <p className="text-white/40 text-xs text-center pt-2">
                  Menunggu pemain lain bergabung...
                </p>
              )}
            </div>

            {/* Start / waiting indicator */}
            {isHost ? (
              <div className="flex flex-col items-center gap-3 w-72">
                {/* Speed slider for host */}
                <div className="bg-white/10 rounded-xl p-3 w-full">
                  <p className="text-white/70 text-xs mb-1">
                    ⚡ Kecepatan awal:{" "}
                    <span className="text-yellow-200 font-bold">
                      {roomSpeed}
                    </span>
                  </p>
                  <input
                    type="range"
                    min="1"
                    max="8"
                    step="0.5"
                    value={roomSpeed}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setRoomSpeed(v);
                      socketRef.current?.emit("update_speed", { speed: v });
                    }}
                    className="w-full accent-pink-400"
                  />
                  <div className="flex justify-between text-white/40 text-xs mt-0.5">
                    <span>Pelan</span>
                    <span>Cepat</span>
                  </div>
                </div>
                <button
                  onClick={() => socketRef.current?.emit("room_ready")}
                  disabled={roomPlayers.length < 2}
                  className="w-full py-3 bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xl font-bold rounded-full shadow-lg transition active:scale-95"
                >
                  ▶️ Mulai Game ({roomPlayers.length}/10)
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <p className="text-white/50 text-sm">
                  ⚡ Kecepatan:{" "}
                  <span className="text-yellow-200 font-bold">{roomSpeed}</span>
                </p>
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="w-3 h-3 rounded-full bg-pink-400 animate-bounce"
                      style={{ animationDelay: `${i * 0.2}s` }}
                    />
                  ))}
                </div>
                <p className="text-white/70 text-sm">
                  Menunggu host memulai...
                </p>
              </div>
            )}
          </div>
        )}

        {/* Last survivor banner */}
        {gamePhase === "playing" && targetScore !== null && !solo && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 pointer-events-none">
            <div className="bg-yellow-400/90 text-gray-900 font-bold text-sm px-4 py-1.5 rounded-full shadow-lg animate-pulse whitespace-nowrap">
              🏆 Kamu tersisa! Kalahkan skor{" "}
              <span className="text-pink-700">{targetScore}</span> untuk menang!
            </div>
          </div>
        )}

        {/* Countdown overlay with opponent info */}
        {gamePhase === "countdown" && !solo && (
          <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-black/60 pointer-events-none">
            {opponentName && (
              <div className="mb-4 text-center animate-pulse">
                <span className="text-green-300 text-lg font-bold">
                  ✅ {opponentName} bergabung!
                </span>
                <p className="text-white/70 text-sm mt-1">
                  Game dimulai dalam...
                </p>
              </div>
            )}
            <div
              className="text-yellow-300 font-extrabold drop-shadow-lg"
              style={{
                fontSize: "140px",
                lineHeight: 1,
                textShadow: "0 0 30px #ff6347",
              }}
            >
              {countdown}
            </div>
            <div className="flex gap-6 mt-6 text-white font-bold text-lg">
              <span>🐷 {username}</span>
              <span className="text-white/40">vs</span>
              <span>🐷 {opponentName || "???"}</span>
            </div>
          </div>
        )}

        {/* Result overlay */}
        {gamePhase === "result" && resultData && (
          <div className="absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-black/70">
            {resultData.myWon || solo ? (
              <div className="text-center animate-bounce">
                <div className="text-8xl mb-2">🏆</div>
                <h2 className="text-yellow-300 text-5xl font-bold drop-shadow-lg">
                  {solo ? "Game Over!" : "MENANG! 🎉"}
                </h2>
              </div>
            ) : (
              <div className="text-center">
                <div
                  className="text-8xl mb-2 animate-spin"
                  style={{ animationDuration: "1s" }}
                >
                  💀
                </div>
                <h2 className="text-red-400 text-5xl font-bold drop-shadow-lg">
                  KALAH!
                </h2>
                {resultData.winner && (
                  <p className="text-white text-xl mt-1">
                    Pemenang:{" "}
                    <span className="text-yellow-300 font-bold">
                      {resultData.winner}
                    </span>
                  </p>
                )}
              </div>
            )}
            <div className="mt-4 bg-white/10 rounded-xl p-4 min-w-65">
              {resultData.scores
                .sort((a, b) => b.score - a.score)
                .map((s, i) => (
                  <div
                    key={i}
                    className="flex justify-between text-white font-semibold py-1 border-b border-white/20 last:border-0"
                  >
                    <span>
                      {i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"} {s.username}
                    </span>
                    <span className="text-yellow-300">{s.score}</span>
                  </div>
                ))}
            </div>
            <button
              onClick={handleRestart}
              className="mt-5 px-8 py-3 bg-pink-500 hover:bg-pink-400 text-white text-xl font-bold rounded-full shadow-lg transition active:scale-95"
            >
              Main Lagi
            </button>
            <a
              href="/leaderboard"
              className="mt-2 text-sm text-white/60 hover:text-white underline"
            >
              Lihat Leaderboard
            </a>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 bg-white/20 backdrop-blur px-6 py-2 rounded-full text-white font-bold shadow">
        <span>⚡ Kecepatan: {gameRef.current.initialSpeed}</span>
      </div>
    </div>
  );
}
