"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { io as socketIO, Socket } from "socket.io-client";

// ── Constants ─────────────────────────────────────────────────────────────────
const W = 800;
const H = 500;
const GROUND_Y = 415;
const GRAVITY = 0.38;
const MAX_CHARGE_MS = 1400;
const TURN_SECS = 45;
const EXPLOSION_R = 110;

const DMG_BASE_MIN = 12;
const DMG_BASE_MAX = 22;
const DMG_BIG_MULT = 1.6;
const DMG_EXPL_DIRECT = 30;
const DMG_EXPL_AREA_MAX = 20;

const WALL_CX = W / 2; // Wall center X
const WALL_HW = 6; // Wall half-width (12px total)
const WALL_TOP_Y = GROUND_Y - Math.round(GROUND_Y / 4); // Wall ~1/4 height from ground

// ── Types ─────────────────────────────────────────────────────────────────────
type PowerUpKey = "big" | "double" | "explosive";
type GamePhase = "waiting" | "playing" | "gameover";

interface PowerUps {
  big: boolean;
  double: boolean;
  explosive: boolean;
}

interface BattlePlayer {
  id: string;
  username: string;
  character: "cat" | "dog";
  x: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  powerUps: PowerUps;
  pigColor: string;
  slot: number;
}

interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  type: "normal" | "big" | "explosive";
  ownerId: string;
  active: boolean;
}

interface FxParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  r: number;
}

interface FxText {
  x: number;
  y: number;
  vy: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

interface FxExplosion {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  maxR: number;
}

interface Cloud {
  x: number;
  y: number;
  w: number;
  speed: number;
}

interface Bird {
  x: number;
  y: number;
  speed: number;
  flapT: number;
}

interface GS {
  phase: GamePhase;
  players: BattlePlayer[];
  myId: string;
  currentTurnId: string | null;
  turnEndTime: number;
  awaitingDouble: boolean;

  aimAngle: number;
  isCharging: boolean;
  chargeStart: number;
  chargePower: number;
  selectedPU: PowerUpKey | null;
  moveKeys: { left: boolean; right: boolean };
  moveLastEmit: number;

  projectile: Projectile | null;
  trail: { x: number; y: number }[];
  particles: FxParticle[];
  texts: FxText[];
  explosions: FxExplosion[];
  clouds: Cloud[];
  birds: Bird[];
  shakeFrames: number;
  shakeAmp: number;

  winnerId: string | null;
  winnerName: string;
  winnerTeam: "cat" | "dog" | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const PIG_COLORS: Record<string, string> = {
  pink: "#ffc8d8",
  blue: "#a8d4ff",
  purple: "#d0a8ff",
  orange: "#ffd0a0",
  green: "#a8f0c0",
  yellow: "#fff0a0",
  red: "#ffb0a8",
  teal: "#a0e8e0",
  white: "#f0f0f0",
  brown: "#d4b090",
};

function shade(hex: string, n: number): string {
  const v = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((v >> 16) & 0xff) + n));
  const g = Math.max(0, Math.min(255, ((v >> 8) & 0xff) + n));
  const b = Math.max(0, Math.min(255, (v & 0xff) + n));
  return `rgb(${r},${g},${b})`;
}

function rr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Props {
  roomId: string;
  username: string;
  pigColor: string;
  character: string;
}

export default function BattleGame({
  roomId,
  username,
  pigColor,
  character,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const rafRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gsRef = useRef<GS>({
    phase: "waiting",
    players: [],
    myId: "",
    currentTurnId: null,
    turnEndTime: 0,
    awaitingDouble: false,

    aimAngle: 45,
    isCharging: false,
    chargeStart: 0,
    chargePower: 0,
    selectedPU: null,
    moveKeys: { left: false, right: false },
    moveLastEmit: 0,

    projectile: null,
    trail: [],
    particles: [],
    texts: [],
    explosions: [],
    clouds: Array.from({ length: 5 }, (_, i) => ({
      x: i * 165 + 40,
      y: 38 + Math.random() * 80,
      w: 70 + Math.random() * 60,
      speed: 0.14 + Math.random() * 0.24,
    })),
    birds: [
      { x: 120, y: 72, speed: 0.5,  flapT: 0 },
      { x: 540, y: 52, speed: 0.65, flapT: 1.8 },
      { x: 310, y: 90, speed: 0.38, flapT: 3.4 },
    ],
    shakeFrames: 0,
    shakeAmp: 0,

    winnerId: null,
    winnerName: "",
    winnerTeam: null,
  });

  const [uiPhase, setUiPhase] = useState<GamePhase>("waiting");
  const [uiPlayers, setUiPlayers] = useState<BattlePlayer[]>([]);
  const [uiHost, setUiHost] = useState("");
  const [uiMyId, setUiMyId] = useState("");
  const [uiWinner, setUiWinner] = useState("");
  const [uiWinnerId, setUiWinnerId] = useState<string | null>(null);
  const [uiWinnerTeam, setUiWinnerTeam] = useState<"cat" | "dog" | null>(null);
  const [rematchVotes, setRematchVotes] = useState({ votes: 0, total: 0 });
  const [voted, setVoted] = useState(false);
  const [mobileSelectedPU, setMobileSelectedPU] = useState<PowerUpKey | null>(
    null,
  );
  const [uiAimAngle, setUiAimAngle] = useState(45);

  // ── Character drawing ────────────────────────────────────────────────────

  function drawCat(
    ctx: CanvasRenderingContext2D,
    x: number,
    base: number,
    color: string,
    fr: boolean,
    dead: boolean,
  ) {
    ctx.globalAlpha = dead ? 0.38 : 1;
    const dk = shade(color, -45);
    const w = 36;
    const h = 42;
    const bx = x - w / 2;
    const by = base - h - 5; // feet take up ~5px

    // tail
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    const tx = fr ? x - 12 : x + 12;
    ctx.moveTo(tx, base - 20);
    ctx.bezierCurveTo(
      tx + (fr ? -24 : 24),
      base - 10,
      tx + (fr ? -32 : 32),
      base - 40,
      tx + (fr ? -22 : 22),
      base - 50,
    );
    ctx.stroke();
    ctx.lineCap = "butt";

    // Ears
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(bx + w * 0.1, by + h * 0.2);
    ctx.lineTo(bx + w * 0.25, by - h * 0.15);
    ctx.lineTo(bx + w * 0.4, by + h * 0.1);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bx + w * 0.9, by + h * 0.2);
    ctx.lineTo(bx + w * 0.75, by - h * 0.15);
    ctx.lineTo(bx + w * 0.6, by + h * 0.1);
    ctx.fill();

    // Body Squircle
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, 14);
    ctx.fill();

    // Eyes
    const eo = fr ? 3 : -3;
    ctx.fillStyle = dead ? "#555" : "#222";
    [-7, 7].forEach((ox) => {
      ctx.beginPath();
      ctx.arc(x + eo + ox, by + h * 0.4, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    if (!dead) {
      ctx.fillStyle = "#fff";
      [-7, 7].forEach((ox) => {
        ctx.beginPath();
        ctx.arc(x + eo + ox + 1, by + h * 0.35, 1.2, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Blush
    ctx.fillStyle = "rgba(255, 100, 150, 0.4)";
    [-10, 10].forEach((ox) => {
      ctx.beginPath();
      ctx.ellipse(x + eo + ox, by + h * 0.55, 4, 2, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // Snout
    ctx.fillStyle = "#f88";
    ctx.beginPath();
    ctx.arc(x + eo, by + h * 0.5, 2, 0, Math.PI * 2);
    ctx.fill();

    // Whiskers
    ctx.strokeStyle = dk;
    ctx.lineWidth = 1;
    [
      [-12, -2],
      [-12, 0],
      [-12, 2],
      [12, -2],
      [12, 0],
      [12, 2],
    ].forEach(([dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(x + eo + (dx < 0 ? -4 : 4), by + h * 0.5);
      ctx.lineTo(x + eo + dx, by + h * 0.5 + dy);
      ctx.stroke();
    });

    // Feet
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(bx + 4, base - 5, 8, 5, 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(bx + w - 12, base - 5, 8, 5, 2);
    ctx.fill();

    ctx.globalAlpha = 1;
  }

  function drawDog(
    ctx: CanvasRenderingContext2D,
    x: number,
    base: number,
    color: string,
    fr: boolean,
    dead: boolean,
  ) {
    ctx.globalAlpha = dead ? 0.38 : 1;
    const dk = shade(color, -50);
    const lt = shade(color, 30);
    const w = 38;
    const h = 44;
    const bx = x - w / 2;
    const by = base - h - 5;

    // Tail
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    const tx = fr ? x - 12 : x + 12;
    ctx.moveTo(tx, base - 25);
    ctx.quadraticCurveTo(
      tx + (fr ? -25 : 25),
      base - 45,
      tx + (fr ? -15 : 15),
      base - 55,
    );
    ctx.stroke();
    ctx.lineCap = "butt";

    // Body Squircle
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, 14);
    ctx.fill();

    // Floppy Ears
    ctx.fillStyle = dk;
    ctx.beginPath();
    ctx.roundRect(bx - 4, by + h * 0.1, 8, h * 0.6, 4);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(bx + w - 4, by + h * 0.1, 8, h * 0.6, 4);
    ctx.fill();

    // Eyes
    const eo = fr ? 3 : -3;
    ctx.fillStyle = dead ? "#555" : "#222";
    [-8, 8].forEach((ox) => {
      ctx.beginPath();
      ctx.arc(x + eo + ox, by + h * 0.35, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    if (!dead) {
      ctx.fillStyle = "#fff";
      [-8, 8].forEach((ox) => {
        ctx.beginPath();
        ctx.arc(x + eo + ox + 1, by + h * 0.3, 1.2, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Blush
    ctx.fillStyle = "rgba(255, 100, 150, 0.4)";
    [-12, 12].forEach((ox) => {
      ctx.beginPath();
      ctx.ellipse(x + eo + ox, by + h * 0.45, 4, 2, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // Snout
    ctx.fillStyle = lt;
    ctx.beginPath();
    ctx.roundRect(x + eo - 12, by + h * 0.5, 24, 16, 6);
    ctx.fill();

    // Nose
    ctx.fillStyle = dead ? "#888" : "#222";
    ctx.beginPath();
    ctx.ellipse(x + eo, by + h * 0.55, 5, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Smile
    if (!dead) {
      ctx.strokeStyle = dk;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x + eo - 3, by + h * 0.65, 3, 0, Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x + eo + 3, by + h * 0.65, 3, 0, Math.PI);
      ctx.stroke();
    }

    // Feet
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(bx + 4, base - 5, 10, 5, 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(bx + w - 14, base - 5, 10, 5, 2);
    ctx.fill();

    ctx.globalAlpha = 1;
  }

  // ── Effects helpers ───────────────────────────────────────────────────────

  function addSparks(x: number, y: number, n: number, color: string) {
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 1.2 + Math.random() * 3;
      gsRef.current.particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 2,
        color,
        r: 2 + Math.random() * 3,
        life: 18 + Math.floor(Math.random() * 15),
        maxLife: 33,
      });
    }
  }

  function addDmgText(x: number, y: number, dmg: number) {
    gsRef.current.texts.push({
      x,
      y,
      vy: -2.2,
      text: `-${dmg}`,
      color: "#FF1744",
      life: 65,
      maxLife: 65,
    });
  }

  function playSound(
    type: "throw" | "hit" | "explosion" | "ground" | "turn" | "win" | "select",
  ) {
    if (typeof window === "undefined") return;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext
        )();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();
      const t = ctx.currentTime;
      switch (type) {
        case "throw": {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(700, t);
          osc.frequency.exponentialRampToValueAtTime(160, t + 0.22);
          gain.gain.setValueAtTime(0.22, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
          osc.start(t);
          osc.stop(t + 0.22);
          break;
        }
        case "hit": {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "square";
          osc.frequency.setValueAtTime(260, t);
          osc.frequency.exponentialRampToValueAtTime(55, t + 0.16);
          gain.gain.setValueAtTime(0.28, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
          osc.start(t);
          osc.stop(t + 0.16);
          break;
        }
        case "explosion": {
          const buf = ctx.createBuffer(
            1,
            Math.ceil(ctx.sampleRate * 0.5),
            ctx.sampleRate,
          );
          const data = buf.getChannelData(0);
          for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          const filt = ctx.createBiquadFilter();
          filt.type = "lowpass";
          filt.frequency.value = 480;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.55, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
          src.connect(filt);
          filt.connect(gain);
          gain.connect(ctx.destination);
          src.start(t);
          src.stop(t + 0.5);
          break;
        }
        case "ground": {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.setValueAtTime(110, t);
          osc.frequency.exponentialRampToValueAtTime(38, t + 0.13);
          gain.gain.setValueAtTime(0.35, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
          osc.start(t);
          osc.stop(t + 0.13);
          break;
        }
        case "turn": {
          [660, 880].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = "sine";
            osc.frequency.value = freq;
            const st = t + i * 0.09;
            gain.gain.setValueAtTime(0.18, st);
            gain.gain.exponentialRampToValueAtTime(0.001, st + 0.15);
            osc.start(st);
            osc.stop(st + 0.15);
          });
          break;
        }
        case "win": {
          [523, 659, 784, 1047].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = "sine";
            osc.frequency.value = freq;
            const st = t + i * 0.12;
            gain.gain.setValueAtTime(0.2, st);
            gain.gain.exponentialRampToValueAtTime(0.001, st + 0.2);
            osc.start(st);
            osc.stop(st + 0.2);
          });
          break;
        }
        case "select": {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.setValueAtTime(480, t);
          osc.frequency.exponentialRampToValueAtTime(760, t + 0.1);
          gain.gain.setValueAtTime(0.15, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
          osc.start(t);
          osc.stop(t + 0.1);
          break;
        }
      }
    } catch {
      /* audio unavailable */
    }
  }

  // ── Game logic ────────────────────────────────────────────────────────────

  const sendResultRef = useRef<
    (hits: { targetId: string; damage: number }[]) => void
  >(() => {});

  useEffect(() => {
    sendResultRef.current = (hits) => {
      hits.forEach((h) => {
        const t = gsRef.current.players.find((p) => p.id === h.targetId);
        if (t) addDmgText(t.x, GROUND_Y - 110, h.damage);
      });
      socketRef.current?.emit("battle_throw_result", { hits });
    };
  });

  // ── Mobile input helpers ──────────────────────────────────────────────────

  function mobilePUSelect(key: PowerUpKey) {
    const gs = gsRef.current;
    if (gs.currentTurnId !== gs.myId) return;
    const me = gs.players.find((p) => p.id === gs.myId);
    if (!me || !me.alive || !me.powerUps[key]) return;
    const next = gs.selectedPU === key ? null : key;
    gs.selectedPU = next;
    setMobileSelectedPU(next);
    if (next) playSound("select");
  }

  function mobileStartCharge(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const gs = gsRef.current;
    if (
      gs.phase !== "playing" ||
      gs.currentTurnId !== gs.myId ||
      gs.projectile ||
      gs.isCharging
    )
      return;
    const me = gs.players.find((p) => p.id === gs.myId);
    if (!me || !me.alive) return;
    gs.isCharging = true;
    gs.chargeStart = Date.now();
    gs.chargePower = 0;
  }

  function mobileReleaseThrow() {
    const gs = gsRef.current;
    if (!gs.isCharging) return;
    gs.isCharging = false;
    if (gs.phase !== "playing" || gs.currentTurnId !== gs.myId || gs.projectile)
      return;
    const me = gs.players.find((p) => p.id === gs.myId);
    if (!me || !me.alive) return;
    const power = Math.min(1, (Date.now() - gs.chargeStart) / MAX_CHARGE_MS);
    gs.chargePower = 0;
    const pu = gs.selectedPU;
    gs.selectedPU = null;
    setMobileSelectedPU(null);
    if (pu) me.powerUps[pu] = false;
    socketRef.current?.emit("battle_throw", {
      angle: gs.aimAngle,
      power,
      powerUp: pu,
      startX: me.x,
    });
  }

  function mobileCancelCharge() {
    const gs = gsRef.current;
    if (gs.isCharging) {
      gs.isCharging = false;
      gs.chargePower = 0;
    }
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      rafRef.current = requestAnimationFrame(render);
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      rafRef.current = requestAnimationFrame(render);
      return;
    }
    const gs = gsRef.current;

    ctx.clearRect(0, 0, W, H);

    if (gs.phase !== "playing") {
      rafRef.current = requestAnimationFrame(render);
      return;
    }

    // ── Screen-shake wrapper ────────────────────────────────────────────────
    ctx.save();
    if (gs.shakeFrames > 0) {
      gs.shakeFrames--;
      const s = gs.shakeAmp * (gs.shakeFrames / 14);
      ctx.translate((Math.random() - 0.5) * s * 2, (Math.random() - 0.5) * s);
    }

    // ── Sky gradient ────────────────────────────────────────────────────────
    const skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    skyGrad.addColorStop(0, "#3a9fd8");
    skyGrad.addColorStop(1, "#c8ecfa");
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, GROUND_Y);

    // ── Sun ─────────────────────────────────────────────────────────────────
    {
      const sx = 68, sy = 60;
      const pulse = Math.sin(Date.now() / 900) * 3;
      ctx.save();
      ctx.shadowColor = "rgba(255,220,60,0.55)";
      ctx.shadowBlur = 28 + pulse;
      ctx.fillStyle = "#FFE84C";
      ctx.beginPath();
      ctx.arc(sx, sy, 22 + pulse * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,215,50,0.55)";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2 + Date.now() / 9000;
        const r1 = 27 + pulse * 0.5;
        const r2 = 40 + pulse;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(ang) * r1, sy + Math.sin(ang) * r1);
        ctx.lineTo(sx + Math.cos(ang) * r2, sy + Math.sin(ang) * r2);
        ctx.stroke();
      }
      ctx.lineCap = "butt";
      ctx.restore();
    }

    // ── Far mountains ───────────────────────────────────────────────────────
    ctx.fillStyle = "#9bbfd4";
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    [[0,315],[70,268],[150,295],[240,252],[320,278],[410,248],[500,270],[590,250],[680,272],[770,258],[800,265],[800,GROUND_Y]].forEach(([x,y])=>ctx.lineTo(x,y));
    ctx.closePath();
    ctx.fill();

    // ── Near hills ──────────────────────────────────────────────────────────
    ctx.fillStyle = "#6eaa80";
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    [[0,380],[90,358],[200,372],[310,350],[430,368],[560,352],[680,366],[800,356],[800,GROUND_Y]].forEach(([x,y])=>ctx.lineTo(x,y));
    ctx.closePath();
    ctx.fill();

    // ── Clouds ──────────────────────────────────────────────────────────────
    ctx.fillStyle = "rgba(255,255,255,0.86)";
    gs.clouds.forEach((c) => {
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, c.w / 2, 16, 0, 0, Math.PI * 2);
      ctx.ellipse(c.x - c.w * 0.28, c.y + 4, c.w * 0.28, 12, 0, 0, Math.PI * 2);
      ctx.ellipse(c.x + c.w * 0.28, c.y + 4, c.w * 0.28, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      c.x += c.speed;
      if (c.x > W + c.w) c.x = -c.w;
    });

    // ── Birds ───────────────────────────────────────────────────────────────
    ctx.strokeStyle = "rgba(40,55,80,0.5)";
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    gs.birds.forEach((b) => {
      b.x += b.speed;
      if (b.x > W + 40) b.x = -40;
      b.flapT += 0.07;
      const wing = Math.sin(b.flapT * 5) * 5;
      ctx.beginPath();
      ctx.moveTo(b.x - 9, b.y + wing);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x + 9, b.y + wing);
      ctx.stroke();
    });
    ctx.lineCap = "butt";

    // ── Ground ──────────────────────────────────────────────────────────────
    ctx.fillStyle = "#4CAF50";
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    // Soil stripe
    ctx.fillStyle = "#8B6914";
    ctx.fillRect(0, GROUND_Y + 14, W, H - GROUND_Y - 14);
    // Top grass strip
    ctx.fillStyle = "#388E3C";
    ctx.fillRect(0, GROUND_Y, W, 14);
    // Grass blades
    ctx.strokeStyle = "#2E7D32";
    ctx.lineWidth = 1;
    for (let gx = 15; gx < W; gx += 28) {
      ctx.beginPath();
      ctx.moveTo(gx, GROUND_Y);
      ctx.lineTo(gx - 4, GROUND_Y - 9);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gx, GROUND_Y);
      ctx.lineTo(gx + 4, GROUND_Y - 9);
      ctx.stroke();
    }
    // Small flowers scattered on ground
    [[55,GROUND_Y-2],[180,GROUND_Y-1],[370,GROUND_Y-2],[440,GROUND_Y-1],[620,GROUND_Y-2],[745,GROUND_Y-1]].forEach(([fx,fy],i)=>{
      ctx.fillStyle = i%2===0 ? "#FF6B6B" : "#FFD93D";
      ctx.beginPath();
      ctx.arc(fx,fy,3,0,Math.PI*2);
      ctx.fill();
      ctx.fillStyle="#2E7D32";
      ctx.fillRect(fx-0.5,fy,1,5);
    });

    // ── Trees (decorative, outside playable zone) ────────────────────────────
    const drawTree = (tx: number, canopyColor: string) => {
      const base = GROUND_Y;
      ctx.fillStyle = "#5a3210";
      ctx.fillRect(tx - 5, base - 40, 10, 40);
      const layers: [number, number, number][] = [[0, -62, 26], [0, -82, 20], [0, -96, 13]];
      layers.forEach(([dx, dy, r]) => {
        ctx.fillStyle = canopyColor;
        ctx.beginPath();
        ctx.arc(tx + dx, base + dy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,0.08)";
        ctx.beginPath();
        ctx.arc(tx + dx + 3, base + dy + 3, r, 0, Math.PI * 2);
        ctx.fill();
      });
    };
    drawTree(20,  "#3a7d4e"); // cat-side far
    drawTree(48,  "#2d6b42"); // cat-side near
    drawTree(752, "#2a6e7a"); // dog-side near
    drawTree(780, "#1e5c68"); // dog-side far

    // ── Team territory banners ───────────────────────────────────────────────
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "rgba(255,200,60,0.18)";
    rr(ctx, 6, WALL_TOP_Y - 38, 105, 28, 8);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 2.5;
    ctx.strokeText("🐱 Tim Kucing", 58, WALL_TOP_Y - 18);
    ctx.fillStyle = "#FFE44C";
    ctx.fillText("🐱 Tim Kucing", 58, WALL_TOP_Y - 18);

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "rgba(80,180,255,0.18)";
    rr(ctx, W - 111, WALL_TOP_Y - 38, 105, 28, 8);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.strokeText("🐶 Tim Anjing", W - 58, WALL_TOP_Y - 18);
    ctx.fillStyle = "#87CEEB";
    ctx.fillText("🐶 Tim Anjing", W - 58, WALL_TOP_Y - 18);

    // ── Territory wall (center divider, shortened) ───────────────────────────
    {
      const WX = WALL_CX;
      const WW = WALL_HW * 2;
      const WT = WALL_TOP_Y;
      const WH = GROUND_Y - WT;
      // Drop shadow
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(WX + WW / 2, WT, 5, WH);
      // Wall top cap (rounded feel)
      ctx.fillStyle = "#6D4C41";
      ctx.beginPath();
      ctx.ellipse(WX, WT, WW / 2 + 3, 6, 0, Math.PI, 0);
      ctx.fill();
      // Wall body gradient
      const wGrad = ctx.createLinearGradient(WX - WW / 2, 0, WX + WW / 2, 0);
      wGrad.addColorStop(0, "#4E342E");
      wGrad.addColorStop(0.3, "#8D6E63");
      wGrad.addColorStop(0.7, "#6D4C41");
      wGrad.addColorStop(1, "#3E2723");
      ctx.fillStyle = wGrad;
      ctx.fillRect(WX - WW / 2, WT, WW, WH);
      // Brick mortar lines
      ctx.strokeStyle = "#3E2723";
      ctx.lineWidth = 0.8;
      for (let wy = WT; wy < GROUND_Y; wy += 16) {
        ctx.beginPath();
        ctx.moveTo(WX - WW / 2, wy);
        ctx.lineTo(WX + WW / 2, wy);
        ctx.stroke();
        const off = Math.floor((wy - WT) / 16) % 2 === 0 ? 0 : WW / 2;
        ctx.beginPath();
        ctx.moveTo(WX - WW / 2 + off, wy);
        ctx.lineTo(WX - WW / 2 + off, Math.min(wy + 16, GROUND_Y));
        ctx.stroke();
      }
      // Edge highlight
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(WX - WW / 2, WT, 2, WH);
    }

    // ── Continuous movement ──────────────────────────────────────────────────
    if (gs.currentTurnId === gs.myId && !gs.projectile) {
      const me = gs.players.find((p) => p.id === gs.myId);
      if (me && me.alive) {
        let moved = false;
        const moveMinX = me.character === "dog" ? 415 : 40;
        const moveMaxX = me.character === "cat" ? 385 : W - 40;
        if (gs.moveKeys.left) {
          me.x = Math.max(moveMinX, me.x - 2.5);
          moved = true;
        }
        if (gs.moveKeys.right) {
          me.x = Math.min(moveMaxX, me.x + 2.5);
          moved = true;
        }
        if (moved && Date.now() - gs.moveLastEmit > 60) {
          gs.moveLastEmit = Date.now();
          socketRef.current?.emit("battle_move", { x: me.x });
        }
      }
    }

    // ── Players ──────────────────────────────────────────────────────────────
    gs.players.forEach((p) => {
      const isMyTurn = p.id === gs.currentTurnId;
      const bodyColor = PIG_COLORS[p.pigColor] || "#ffc8d8";

      // Face nearest enemy (opposite team). Fall back to nearest alive player if no enemies alive.
      const enemies = gs.players.filter((o) => o.id !== p.id && o.alive && o.character !== p.character);
      const facingPool = enemies.length > 0 ? enemies : gs.players.filter((o) => o.id !== p.id && o.alive);
      let fr = p.character === "cat"; // cats default face right, dogs face left
      if (facingPool.length > 0) {
        const nearest = facingPool.reduce((a, b) =>
          Math.abs(b.x - p.x) < Math.abs(a.x - p.x) ? b : a,
        );
        fr = nearest.x >= p.x;
      }

      // Pulsing ground ring under active player
      if (isMyTurn && p.alive) {
        const pulseR = 22 + Math.sin(Date.now() / 140) * 5;
        ctx.globalAlpha = 0.22 + Math.sin(Date.now() / 140) * 0.1;
        ctx.fillStyle = "#FFD700";
        ctx.beginPath();
        ctx.ellipse(p.x, GROUND_Y + 2, pulseR, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      const bobY = (isMyTurn && p.alive) ? Math.sin(Date.now() / 190) * 3 : 0;
      if (isMyTurn) {
        ctx.shadowColor = "#FFD700";
        ctx.shadowBlur = 20;
      }
      if (p.character === "cat")
        drawCat(ctx, p.x, GROUND_Y - bobY, bodyColor, fr, !p.alive);
      else drawDog(ctx, p.x, GROUND_Y - bobY, bodyColor, fr, !p.alive);
      ctx.shadowBlur = 0;

      // HP bar
      const bw = 62;
      const bh = 9;
      const bx = p.x - bw / 2;
      const by = GROUND_Y - 108;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      rr(ctx, bx - 1, by - 1, bw + 2, bh + 2, 3);
      ctx.fill();
      const hpR = p.hp / p.maxHp;
      ctx.fillStyle =
        hpR > 0.5 ? "#4CAF50" : hpR > 0.25 ? "#FFC107" : "#F44336";
      if (hpR > 0) {
        rr(ctx, bx, by, bw * hpR, bh, 3);
        ctx.fill();
      }

      ctx.fillStyle = "white";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${p.hp}/${p.maxHp}`, p.x, by - 2);

      ctx.font = "bold 13px sans-serif";
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.lineWidth = 3;
      ctx.strokeText(p.username, p.x, by - 16);
      ctx.fillStyle = isMyTurn ? "#FFD700" : "#ffffff";
      ctx.fillText(p.username, p.x, by - 16);

      // Power-up icons
      if (p.alive) {
        const pwIcons: [PowerUpKey, string][] = [
          ["big", "🔥"],
          ["double", "✌️"],
          ["explosive", "💣"],
        ];
        const avail = pwIcons.filter(([k]) => p.powerUps[k]);
        const iconY = by + bh + 14;
        const startPx = p.x - (avail.length * 14) / 2 + 7;
        avail.forEach(([k, icon], i) => {
          const ipx = startPx + i * 16;
          if (isMyTurn && gs.selectedPU === k) {
            ctx.fillStyle = "#FFD700";
            rr(ctx, ipx - 9, iconY - 9, 18, 18, 4);
            ctx.fill();
          }
          ctx.font = "12px sans-serif";
          ctx.fillText(icon, ipx, iconY + 2);
        });
      }

      if (!p.alive) {
        ctx.font = "22px sans-serif";
        ctx.fillText("💀", p.x, GROUND_Y - 50);
      }
    });

    // ── Aim preview: curved path (1/5) + angle badge ─────────────────────────
    const me = gs.players.find((p) => p.id === gs.myId);
    if (gs.currentTurnId === gs.myId && me && me.alive && !gs.projectile) {
      // Aim towards nearest enemy (opposite team). Fall back to nearest alive player.
      const aimEnemies = gs.players.filter((p) => p.id !== gs.myId && p.alive && p.character !== me.character);
      const aimPool = aimEnemies.length > 0 ? aimEnemies : gs.players.filter((p) => p.id !== gs.myId && p.alive);
      let dir = me.character === "cat" ? 1 : -1;
      if (aimPool.length > 0) {
        const nearest = aimPool.reduce((a, b) =>
          Math.abs(b.x - me.x) < Math.abs(a.x - me.x) ? b : a,
        );
        dir = nearest.x >= me.x ? 1 : -1;
      }
      const rad = (gs.aimAngle * Math.PI) / 180;
      const spd = (gs.isCharging ? gs.chargePower : 0.5) * 16;
      let px = me.x;
      let py = GROUND_Y - 30;
      let vx = Math.cos(rad) * spd * dir;
      let vy = -Math.sin(rad) * spd;
      // Curved trajectory — first 1/5 only (11 steps)
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(255,240,80,0.92)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px, py);
      for (let i = 0; i < 11; i++) {
        px += vx;
        py += vy;
        vy += GRAVITY;
        if (py >= GROUND_Y || px < 0 || px > W) break;
        if (
          px >= WALL_CX - WALL_HW &&
          px <= WALL_CX + WALL_HW &&
          py >= WALL_TOP_Y
        )
          break;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // Angle badge directly above the character
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "center";
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.lineWidth = 3;
      ctx.strokeText(`🎯 ${gs.aimAngle}°`, me.x, GROUND_Y - 128);
      ctx.fillStyle = "#FFD700";
      ctx.fillText(`🎯 ${gs.aimAngle}°`, me.x, GROUND_Y - 128);
    }

    // ── Power bar ─────────────────────────────────────────────────────────────
    if (gs.isCharging) {
      gs.chargePower = Math.min(
        1,
        (Date.now() - gs.chargeStart) / MAX_CHARGE_MS,
      );
      const bx = W / 2 - 90;
      const by = H - 36;
      const bw = 180;
      const bh = 16;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      rr(ctx, bx - 2, by - 2, bw + 4, bh + 4, 5);
      ctx.fill();
      const col =
        gs.chargePower < 0.5
          ? "#4CAF50"
          : gs.chargePower < 0.8
            ? "#FFC107"
            : "#F44336";
      ctx.fillStyle = col;
      rr(ctx, bx, by, bw * gs.chargePower, bh, 4);
      ctx.fill();
      ctx.fillStyle = "white";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        `💪 ${Math.round(gs.chargePower * 100)}%`,
        W / 2,
        by + bh + 16,
      );
    }

    // ── Projectile trail ──────────────────────────────────────────────────────
    if (gs.projectile?.active) {
      gs.trail.push({ x: gs.projectile.x, y: gs.projectile.y });
      if (gs.trail.length > 20) gs.trail.shift();
      const trailColor = gs.projectile.type === "explosive" ? "#FF6B35" : gs.projectile.type === "big" ? "#FFD700" : "#90EE90";
      gs.trail.forEach((pt, i) => {
        const ratio = i / gs.trail.length;
        ctx.globalAlpha = ratio * 0.6;
        ctx.fillStyle = trailColor;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4 * ratio, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    } else if (gs.trail.length > 0) {
      gs.trail = [];
    }

    // ── Projectile ────────────────────────────────────────────────────────────
    if (gs.projectile && gs.projectile.active) {
      const proj = gs.projectile;
      proj.x += proj.vx;
      proj.y += proj.vy;
      proj.vy += GRAVITY;

      const isMyProj = proj.ownerId === gs.myId;

      // Ground hit
      if (proj.y >= GROUND_Y - 5) {
        proj.active = false;
        if (proj.type === "explosive") {
          gs.explosions.push({ x: proj.x, y: GROUND_Y, life: 45, maxLife: 45, maxR: EXPLOSION_R });
          gs.explosions.push({ x: proj.x, y: GROUND_Y, life: 30, maxLife: 30, maxR: EXPLOSION_R * 0.5 });
          gs.shakeFrames = 14; gs.shakeAmp = 12;
          addSparks(proj.x, GROUND_Y, 28, "#FF6B35");
          addSparks(proj.x, GROUND_Y, 14, "#FFD700");
          playSound("explosion");
          if (isMyProj) {
            const hits: { targetId: string; damage: number }[] = [];
            gs.players
              .filter((p) => p.id !== proj.ownerId && p.alive)
              .forEach((p) => {
                const dist = Math.abs(p.x - proj.x);
                if (dist < EXPLOSION_R) {
                  hits.push({
                    targetId: p.id,
                    damage: Math.round(
                      DMG_EXPL_DIRECT +
                        DMG_EXPL_AREA_MAX * (1 - dist / EXPLOSION_R),
                    ),
                  });
                }
              });
            sendResultRef.current(hits);
          }
        } else {
          addSparks(proj.x, GROUND_Y, 6, "#8BC34A");
          playSound("ground");
          if (isMyProj) sendResultRef.current([]);
        }
      }
      // OOB
      else if (proj.x < -60 || proj.x > W + 60) {
        proj.active = false;
        if (isMyProj) sendResultRef.current([]);
      }
      // Wall hit
      else if (
        proj.x >= WALL_CX - WALL_HW - proj.size / 2 &&
        proj.x <= WALL_CX + WALL_HW + proj.size / 2 &&
        proj.y >= WALL_TOP_Y
      ) {
        proj.active = false;
        addSparks(proj.x, Math.max(proj.y, WALL_TOP_Y + 4), 10, "#8D6E63");
        playSound("ground");
        if (isMyProj) sendResultRef.current([]);
      }
      // Player hit
      else {
        let hit = false;
        const targets = gs.players.filter(
          (p) => p.id !== proj.ownerId && p.alive,
        );
        for (const t of targets) {
          const hitR = proj.type === "big" ? 36 : 26;
          const dy = GROUND_Y - 42 - proj.y;
          const dx = t.x - proj.x;
          if (Math.sqrt(dx * dx + dy * dy) < hitR) {
            proj.active = false;
            hit = true;
            if (proj.type === "explosive") {
              gs.explosions.push({ x: proj.x, y: proj.y, life: 45, maxLife: 45, maxR: EXPLOSION_R });
              gs.explosions.push({ x: proj.x, y: proj.y, life: 28, maxLife: 28, maxR: EXPLOSION_R * 0.45 });
              gs.shakeFrames = 14; gs.shakeAmp = 12;
              addSparks(proj.x, proj.y, 28, "#FF6B35");
              addSparks(proj.x, proj.y, 14, "#FFD700");
              playSound("explosion");
              if (isMyProj) {
                const hits: { targetId: string; damage: number }[] = [];
                gs.players
                  .filter((p) => p.id !== proj.ownerId && p.alive)
                  .forEach((p2) => {
                    const dist = Math.sqrt(
                      (p2.x - proj.x) ** 2 + (GROUND_Y - 42 - proj.y) ** 2,
                    );
                    if (dist < EXPLOSION_R)
                      hits.push({
                        targetId: p2.id,
                        damage: Math.round(
                          DMG_EXPL_DIRECT +
                            DMG_EXPL_AREA_MAX * (1 - dist / EXPLOSION_R),
                        ),
                      });
                  });
                sendResultRef.current(hits);
              }
            } else {
              addSparks(proj.x, proj.y, 10, "#FFD700");
              playSound("hit");
              if (isMyProj) {
                const bd =
                  DMG_BASE_MIN + Math.random() * (DMG_BASE_MAX - DMG_BASE_MIN);
                const dmg = Math.round(
                  proj.type === "big" ? bd * DMG_BIG_MULT : bd,
                );
                sendResultRef.current([{ targetId: t.id, damage: dmg }]);
              }
            }
            break;
          }
        }
        void hit;
      }

      // Draw bamboo
      if (gs.projectile?.active) {
        const p = gs.projectile;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.atan2(p.vy, p.vx));
        const len = p.size * 2.4;
        const th = p.size * 0.45;
        ["#4CAF50", "#66BB6A", "#4CAF50"].forEach((col, i) => {
          ctx.fillStyle = col;
          ctx.fillRect(-len / 2 + i * (len / 3), -th / 2, len / 3 - 1, th);
        });
        ctx.strokeStyle = "#2E7D32";
        ctx.lineWidth = 0.8;
        [1, 2].forEach((i) => {
          const jx = -len / 2 + i * (len / 3);
          ctx.beginPath();
          ctx.moveTo(jx, -th / 2);
          ctx.lineTo(jx, th / 2);
          ctx.stroke();
        });
        if (p.type === "big") {
          ctx.fillStyle = "rgba(255,200,0,0.65)";
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
        if (p.type === "explosive") {
          ctx.fillStyle = "rgba(255,80,0,0.6)";
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // ── Explosions ────────────────────────────────────────────────────────────
    gs.explosions = gs.explosions.filter((e) => e.life > 0);
    gs.explosions.forEach((e) => {
      e.life--;
      const t = 1 - e.life / e.maxLife;
      const r = e.maxR * t;
      const alpha = e.life / e.maxLife;
      // Inner white flash (early phase only)
      if (t < 0.25) {
        ctx.globalAlpha = (1 - t / 0.25) * 0.8;
        ctx.fillStyle = "#FFFFFF";
        ctx.beginPath();
        ctx.arc(e.x, e.y, r * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      // Orange-red outer ring
      ctx.globalAlpha = alpha * 0.9;
      const grad = ctx.createRadialGradient(e.x, e.y, r * 0.3, e.x, e.y, r);
      grad.addColorStop(0, "rgba(255,220,60,0.7)");
      grad.addColorStop(0.5, "rgba(255,100,20,0.5)");
      grad.addColorStop(1, "rgba(255,50,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
      // Ring outline
      ctx.globalAlpha = alpha * 0.7;
      ctx.strokeStyle = "#FF4500";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // ── Particles ─────────────────────────────────────────────────────────────
    gs.particles = gs.particles.filter((p) => p.life > 0);
    gs.particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.12;
      p.life--;
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    // ── Floating damage text ──────────────────────────────────────────────────
    gs.texts = gs.texts.filter((t) => t.life > 0);
    gs.texts.forEach((t) => {
      t.y += t.vy;
      t.vy *= 0.92;
      t.life--;
      ctx.globalAlpha = t.life / t.maxLife;
      ctx.font = "bold 18px sans-serif";
      ctx.textAlign = "center";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 3;
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    });
    ctx.globalAlpha = 1;

    // ── HUD ──────────────────────────────────────────────────────────────────
    if (gs.currentTurnId) {
      const curP = gs.players.find((p) => p.id === gs.currentTurnId);
      const remaining = Math.max(
        0,
        Math.ceil((gs.turnEndTime - Date.now()) / 1000),
      );
      const isMe = gs.currentTurnId === gs.myId;
      const label =
        gs.awaitingDouble && isMe
          ? "⚔️ Lempar LAGI!"
          : isMe
            ? "⚔️ Giliran KAMU!"
            : `🎮 Giliran ${curP?.username ?? "?"}`;

      // Box with glow border
      ctx.shadowColor = isMe ? "#FFD700" : "#4488ff";
      ctx.shadowBlur = 14;
      ctx.fillStyle = isMe ? "rgba(160,110,0,0.92)" : "rgba(15,15,50,0.90)";
      rr(ctx, W / 2 - 135, 6, 270, 54, 12);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = isMe ? "#FFD700" : "#6699ff";
      ctx.lineWidth = 2;
      rr(ctx, W / 2 - 135, 6, 270, 54, 12);
      ctx.stroke();

      ctx.font = "bold 15px sans-serif";
      ctx.textAlign = "center";
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.lineWidth = 3;
      ctx.strokeText(label, W / 2, 29);
      ctx.fillStyle = isMe ? "#fff8c0" : "#ffffff";
      ctx.fillText(label, W / 2, 29);

      const timerColor =
        remaining <= 5
          ? "#FF5555"
          : remaining <= 10
            ? "#FFBB00"
            : isMe
              ? "#fff8c0"
              : "rgba(200,220,255,0.9)";
      ctx.font = "bold 13px sans-serif";
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.lineWidth = 2;
      ctx.strokeText(`⏱ ${remaining}s`, W / 2, 49);
      ctx.fillStyle = timerColor;
      ctx.fillText(`⏱ ${remaining}s`, W / 2, 49);
    }

    // Controls hint
    if (gs.currentTurnId === gs.myId && !gs.projectile) {
      ctx.fillStyle = "rgba(0,0,0,0.42)";
      rr(ctx, 8, H - 52, 340, 44, 8);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(
        "🎮  A / D : Gerak    ↑ ↓ : Sudut    [Space] : Tahan + Lepas = Lempar",
        14,
        H - 35,
      );
      ctx.fillText(
        "💡  [1] 🔥 Besar    [2] ✌️ Dua Kali    [3] 💣 Ledak",
        14,
        H - 20,
      );

      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`Sudut: ${gsRef.current.aimAngle}°`, W - 10, H - 20);
      if (gsRef.current.selectedPU) {
        const lbl: Record<PowerUpKey, string> = {
          big: "🔥 Besar aktif",
          double: "✌️ Dua Kali aktif",
          explosive: "💣 Ledak aktif",
        };
        ctx.fillStyle = "#FFD700";
        ctx.fillText(lbl[gsRef.current.selectedPU], W - 10, H - 36);
      }
    }

    // Auto-skip when timer expires
    if (
      gs.currentTurnId === gs.myId &&
      !gs.projectile &&
      gs.turnEndTime > 0 &&
      Date.now() > gs.turnEndTime
    ) {
      gs.isCharging = false;
      gs.chargePower = 0;
      gs.turnEndTime = 0;
      sendResultRef.current([]);
    }

    ctx.restore(); // end screen-shake wrapper
    rafRef.current = requestAnimationFrame(render);
  }, []);

  // ── Keyboard input ────────────────────────────────────────────────────────
  useEffect(() => {
    function kd(e: KeyboardEvent) {
      const gs = gsRef.current;
      if (gs.phase !== "playing") return;
      if (gs.currentTurnId !== gs.myId) return;
      const me = gs.players.find((p) => p.id === gs.myId);
      if (!me || !me.alive) return;

      switch (e.code) {
        case "ArrowLeft":
        case "KeyA":
          e.preventDefault();
          gs.moveKeys.left = true;
          break;
        case "ArrowRight":
        case "KeyD":
          e.preventDefault();
          gs.moveKeys.right = true;
          break;
        case "ArrowUp":
          e.preventDefault();
          if (!gs.projectile) {
            gs.aimAngle = Math.min(85, gs.aimAngle + 5);
            setUiAimAngle(gs.aimAngle);
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          if (!gs.projectile) {
            gs.aimAngle = Math.max(5, gs.aimAngle - 5);
            setUiAimAngle(gs.aimAngle);
          }
          break;
        case "Space":
        case "KeyZ":
          e.preventDefault();
          if (!gs.isCharging && !gs.projectile) {
            gs.isCharging = true;
            gs.chargeStart = Date.now();
            gs.chargePower = 0;
          }
          break;
        case "Digit1":
          if (me.powerUps.big) {
            const n = gs.selectedPU === "big" ? null : "big";
            gs.selectedPU = n;
            if (n) playSound("select");
          }
          break;
        case "Digit2":
          if (me.powerUps.double) {
            const n = gs.selectedPU === "double" ? null : "double";
            gs.selectedPU = n;
            if (n) playSound("select");
          }
          break;
        case "Digit3":
          if (me.powerUps.explosive) {
            const n = gs.selectedPU === "explosive" ? null : "explosive";
            gs.selectedPU = n;
            if (n) playSound("select");
          }
          break;
      }
    }

    function ku(e: KeyboardEvent) {
      const gs = gsRef.current;
      if (e.code === "ArrowLeft" || e.code === "KeyA") gs.moveKeys.left = false;
      if (e.code === "ArrowRight" || e.code === "KeyD")
        gs.moveKeys.right = false;

      if ((e.code === "Space" || e.code === "KeyZ") && gs.isCharging) {
        e.preventDefault();
        gs.isCharging = false;
        if (
          gs.phase !== "playing" ||
          gs.currentTurnId !== gs.myId ||
          gs.projectile
        )
          return;
        const me = gs.players.find((p) => p.id === gs.myId);
        if (!me || !me.alive) return;

        const power = Math.min(
          1,
          (Date.now() - gs.chargeStart) / MAX_CHARGE_MS,
        );
        gs.chargePower = 0;
        const pu = gs.selectedPU;
        gs.selectedPU = null;
        if (pu) me.powerUps[pu] = false;

        socketRef.current?.emit("battle_throw", {
          angle: gs.aimAngle,
          power,
          powerUp: pu,
          startX: me.x,
        });
      }
    }

    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  // ── Socket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const exUrl = process.env.NEXT_PUBLIC_SOCKET_URL || "";
    const path = exUrl ? "/socket.io" : "/api/socketio";

    const socket = socketIO(
      exUrl || (typeof window !== "undefined" ? window.location.origin : ""),
      {
        path,
        transports: ["websocket", "polling"],
      },
    );
    socketRef.current = socket;

    socket.on("connect", () => {
      const id = socket.id || "";
      gsRef.current.myId = id;
      setUiMyId(id);
      socket.emit("battle_join", { roomId, username, pigColor, character });
    });

    socket.on(
      "battle_room_state",
      (data: { players: BattlePlayer[]; host: string; started: boolean }) => {
        const gs = gsRef.current;
        gs.players = data.players;
        if (!data.started) gs.phase = "waiting";
        setUiPlayers([...data.players]);
        setUiHost(data.host);
        if (!data.started) setUiPhase("waiting");
      },
    );

    socket.on(
      "battle_game_start",
      (data: { players: BattlePlayer[]; currentTurnId: string }) => {
        const gs = gsRef.current;
        gs.players = data.players;
        gs.currentTurnId = data.currentTurnId;
        gs.phase = "playing";
        gs.turnEndTime = Date.now() + TURN_SECS * 1000;
        gs.awaitingDouble = false;
        gs.projectile = null;
        gs.particles = [];
        gs.texts = [];
        gs.explosions = [];
        setUiPlayers([...data.players]);
        setUiPhase("playing");
        setVoted(false);
        setMobileSelectedPU(null);
        setUiAimAngle(45);
        setRematchVotes({ votes: 0, total: 0 });
      },
    );

    socket.on("battle_player_moved", (d: { id: string; x: number }) => {
      const p = gsRef.current.players.find((p) => p.id === d.id);
      if (p) p.x = d.x;
    });

    socket.on(
      "battle_projectile",
      (d: {
        throwerId: string;
        angle: number;
        power: number;
        powerUp: PowerUpKey | null;
        startX: number;
      }) => {
        const gs = gsRef.current;
        const thrower = gs.players.find((p) => p.id === d.throwerId);
        let dir = 1;
        if (thrower) {
          // Projectile flies towards nearest enemy (opposite team). Fall back to nearest alive player.
          const projEnemies = gs.players.filter((p) => p.id !== d.throwerId && p.alive && p.character !== thrower.character);
          const projPool = projEnemies.length > 0 ? projEnemies : gs.players.filter((p) => p.id !== d.throwerId && p.alive);
          dir = thrower.character === "cat" ? 1 : -1;
          if (projPool.length > 0) {
            const nearest = projPool.reduce((a, b) =>
              Math.abs(b.x - thrower.x) < Math.abs(a.x - thrower.x) ? b : a,
            );
            dir = nearest.x >= thrower.x ? 1 : -1;
          }
        }
        const rad = (d.angle * Math.PI) / 180;
        const spd = d.power * 16;
        const type =
          d.powerUp === "big"
            ? "big"
            : d.powerUp === "explosive"
              ? "explosive"
              : "normal";
        gs.projectile = {
          x: d.startX,
          y: GROUND_Y - 30,
          vx: Math.cos(rad) * spd * dir,
          vy: -Math.sin(rad) * spd,
          size: type === "big" ? 16 : 10,
          type,
          ownerId: d.throwerId,
          active: true,
        };
        gs.awaitingDouble = false;
        playSound("throw");
      },
    );

    socket.on(
      "battle_state_update",
      (d: {
        players: BattlePlayer[];
        currentTurnId: string;
        hits: { targetId: string; damage: number }[];
        awaitingDouble: boolean;
      }) => {
        const gs = gsRef.current;
        d.players.forEach((sp) => {
          const lp = gs.players.find((p) => p.id === sp.id);
          if (lp) Object.assign(lp, sp);
        });
        d.hits?.forEach((h) => {
          const t = gs.players.find((p) => p.id === h.targetId);
          if (t) addDmgText(t.x, GROUND_Y - 110, h.damage);
        });
        gs.currentTurnId = d.currentTurnId;
        gs.awaitingDouble = d.awaitingDouble;
        gs.turnEndTime = Date.now() + TURN_SECS * 1000;
        gs.projectile = null;
        gs.isCharging = false;
        gs.chargePower = 0;
        setUiPlayers([...gs.players]);
        setMobileSelectedPU(null);
        playSound("turn");
      },
    );

    socket.on(
      "battle_game_over",
      (d: {
        winnerId: string | null;
        winnerName: string;
        winnerTeam?: "cat" | "dog" | null;
        players: BattlePlayer[];
      }) => {
        const gs = gsRef.current;
        gs.phase = "gameover";
        gs.winnerId = d.winnerId;
        gs.winnerName = d.winnerName;
        gs.winnerTeam = d.winnerTeam ?? null;
        gs.players = d.players;
        gs.projectile = null;
        setUiPhase("gameover");
        setUiWinner(d.winnerName);
        setUiWinnerId(d.winnerId ?? null);
        setUiWinnerTeam(d.winnerTeam ?? null);
        setUiPlayers([...d.players]);
        playSound("win");
      },
    );

    socket.on("battle_rematch_votes", (d: { votes: number; total: number }) =>
      setRematchVotes(d),
    );

    socket.on("battle_player_left", (d: { id: string }) => {
      const gs = gsRef.current;
      gs.players = gs.players.filter((p) => p.id !== d.id);
      setUiPlayers([...gs.players]);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, username, pigColor, character]);

  // Start RAF
  useEffect(() => {
    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, [render]);

  const isHost = uiHost === uiMyId;

  return (
    <div className="flex-1 w-full flex flex-col items-center justify-center gap-3">
      {/* Waiting room */}
      {uiPhase === "waiting" && (
        <div className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-[2rem] p-8 w-full max-w-lg text-white shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-40 h-40 bg-purple-500/30 blur-[50px] rounded-full pointer-events-none -mr-10 -mt-10" />
          <div className="absolute bottom-0 left-0 w-40 h-40 bg-pink-500/30 blur-[50px] rounded-full pointer-events-none -ml-10 -mb-10" />

          <h2 className="text-3xl font-black text-center mb-6 drop-shadow-lg">
            ⚔️ <span className="bg-clip-text text-transparent bg-linear-to-r from-yellow-300 to-orange-400">Battle Room</span>
          </h2>
          
          <div className="bg-black/30 border border-white/10 rounded-2xl p-4 mb-6 text-center relative overflow-hidden">
            <p className="text-white/60 text-xs font-bold uppercase tracking-wider mb-1">Kode Room</p>
            <p className="font-mono font-black text-3xl tracking-[0.2em] text-yellow-300 drop-shadow-md">
              {roomId}
            </p>
          </div>
          <p className="text-white/70 text-sm text-center mb-3">
            Pilih posisi ({uiPlayers.length}/6) — butuh minimal 2:
          </p>
          {(() => {
            const cats = uiPlayers.filter((p) => p.character === "cat").length;
            const dogs = uiPlayers.filter((p) => p.character === "dog").length;
            const total = uiPlayers.length;
            if (total >= 2 && cats !== dogs) {
              const minority = Math.min(cats, dogs);
              const majority = Math.max(cats, dogs);
              const boostedHp = Math.min(200, Math.round(100 * majority / minority));
              const smallSide = cats < dogs ? "🐱 Kucing" : "🐶 Anjing";
              return (
                <p className="text-yellow-300 text-xs text-center mb-3 bg-yellow-400/10 rounded-xl px-3 py-2">
                  ⚡ Tim <b>{smallSide}</b> lebih sedikit → mendapat <b>{boostedHp} HP</b> per pemain!
                </p>
              );
            }
            if (total === 6) return (
              <p className="text-sky-300 text-xs text-center mb-3 bg-sky-400/10 rounded-xl px-3 py-2">
                ⚔️ 3 vs 3 — Tim Kucing 🐱 vs Tim Anjing 🐶! Habiskan semua lawan!
              </p>
            );
            if (total === 4) return (
              <p className="text-sky-300 text-xs text-center mb-3 bg-sky-400/10 rounded-xl px-3 py-2">
                ⚔️ 2 vs 2 — Tim Kucing 🐱 vs Tim Anjing 🐶!
              </p>
            );
            return null;
          })()}

          {/* Slot selection grid */}
          <div className="grid grid-cols-2 gap-3 mb-6 relative z-10">
            {[0, 1, 2, 3, 4, 5].map((slotIdx) => {
              const occupant = uiPlayers.find((p) => p.slot === slotIdx);
              const isMe = occupant?.id === uiMyId;
              const myPlayer = uiPlayers.find((p) => p.id === uiMyId);
              const isMine = myPlayer?.slot === slotIdx;
              const charEmoji = slotIdx % 2 === 0 ? "🐱" : "🐶";
              const charLabel = slotIdx % 2 === 0 ? "Kucing" : "Anjing";
              const sideLabel = slotIdx % 2 === 0
                ? ["Kiri 1", "Kiri 2", "Kiri 3"][slotIdx / 2]
                : ["Kanan 1", "Kanan 2", "Kanan 3"][(slotIdx - 1) / 2];
              return (
                <div
                  key={slotIdx}
                  className={`relative overflow-hidden rounded-2xl p-3 border-2 transition-all duration-300 ${
                    isMine
                      ? "bg-yellow-400/20 border-yellow-400 shadow-[0_0_15px_rgba(250,204,21,0.3)] scale-[1.02]"
                      : occupant
                        ? "bg-black/40 border-white/10"
                        : "bg-white/5 border-dashed border-white/20 hover:border-white/40 hover:bg-white/10"
                  }`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-2xl shrink-0 ${isMine ? 'bg-yellow-400/30' : 'bg-white/10'}`}>
                      {charEmoji}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white/60 font-bold text-[10px] uppercase tracking-wider">
                        {charLabel} — {sideLabel}
                      </p>
                      {occupant ? (
                        <p className="text-white font-bold text-sm truncate">
                          {occupant.username}
                          {isMe && (
                            <span className="text-green-400 ml-1 text-xs">(Kamu)</span>
                          )}
                          {occupant.id === uiHost && (
                            <span className="text-yellow-400 ml-1" title="Host">👑</span>
                          )}
                        </p>
                      ) : (
                        <p className="text-white/30 text-sm font-medium italic">Kosong</p>
                      )}
                    </div>
                  </div>
                  {!isMine && !occupant && (
                    <button
                      onClick={() =>
                        socketRef.current?.emit("battle_pick_slot", {
                          slot: slotIdx,
                        })
                      }
                      className="w-full py-1.5 text-xs font-bold bg-white/10 hover:bg-white/25 text-white rounded-xl transition-all active:scale-95"
                    >
                      + Pilih Posisi
                    </button>
                  )}
                  {isMine && (
                    <div className="w-full py-1.5 bg-yellow-400/20 rounded-xl">
                      <p className="text-yellow-300 text-xs text-center font-bold">
                        ✓ Posisimu
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {uiPlayers.length < 2 && (
            <p className="text-white/40 text-xs text-center mb-3">
              Butuh minimal 2 pemain...
            </p>
          )}

          {isHost ? (
            <button
              onClick={() => socketRef.current?.emit("battle_start")}
              disabled={uiPlayers.length < 2}
              className="w-full py-3 bg-linear-to-r from-red-500 to-orange-500 hover:from-red-400 hover:to-orange-400 disabled:opacity-40 text-white font-extrabold rounded-2xl text-lg transition active:scale-95 shadow-lg"
            >
              ⚔️ Mulai Battle! {uiPlayers.length < 2 ? "(min 2 pemain)" : ""}
            </button>
          ) : (
            <div className="text-center text-white/50 py-2 text-sm">
              Menunggu host memulai...
            </div>
          )}

          <div className="mt-4 bg-black/20 rounded-xl p-3 text-white/50 text-xs space-y-1">
            <p>
              🎮 <b>A / D</b> — Gerak kiri/kanan
            </p>
            <p>
              🎯 <b>↑ ↓</b> — Atur sudut lemparan
            </p>
            <p>
              💨 <b>[Space]</b> — Tahan untuk isi daya, lepas untuk lempar
            </p>
            <p>
              ⚡ <b>[1] [2] [3]</b> — Pilih power-up sebelum lempar
            </p>
            <p>
              🔥 Big &nbsp;|&nbsp; ✌️ Dua Kali &nbsp;|&nbsp; 💣 Lemparan Ledak
            </p>
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="rounded-2xl shadow-2xl w-full h-auto max-w-[1200px] aspect-[800/500] object-contain"
        style={{ display: uiPhase === "playing" ? "block" : "none" }}
      />

      {/* Mobile controls — visible during gameplay */}
      {uiPhase === "playing" && (
        <div className="w-full max-w-[1200px] flex flex-col gap-2 px-2 select-none">
          {/* Row 1: Move ← → | Aim ↑↓ | Throw button */}
          <div className="flex gap-2 mb-2 items-stretch h-[4.5rem]">
            {/* Move Left / Right */}
            <div className="flex gap-2 shrink-0">
              <button
                className="w-16 rounded-2xl bg-white/10 border border-white/20 active:bg-white/30 active:scale-95 text-white text-2xl font-bold shadow-lg touch-none flex items-center justify-center transition-all backdrop-blur-md"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  gsRef.current.moveKeys.left = true;
                  playSound("select");
                }}
                onPointerUp={() => {
                  gsRef.current.moveKeys.left = false;
                }}
                onPointerCancel={() => {
                  gsRef.current.moveKeys.left = false;
                }}
              >
                ◀
              </button>
              <button
                className="w-16 rounded-2xl bg-white/10 border border-white/20 active:bg-white/30 active:scale-95 text-white text-2xl font-bold shadow-lg touch-none flex items-center justify-center transition-all backdrop-blur-md"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  gsRef.current.moveKeys.right = true;
                  playSound("select");
                }}
                onPointerUp={() => {
                  gsRef.current.moveKeys.right = false;
                }}
                onPointerCancel={() => {
                  gsRef.current.moveKeys.right = false;
                }}
              >
                ▶
              </button>
            </div>

            {/* Aim up / down + angle display */}
            <div className="flex flex-col gap-1 shrink-0 items-center justify-between w-[4.5rem]">
              <button
                className="flex-1 w-full rounded-xl bg-white/10 border border-white/20 active:bg-white/30 active:scale-95 text-white text-xs font-black shadow-lg flex items-center justify-center transition-all backdrop-blur-md"
                onClick={() => {
                  playSound("select");
                  const gs = gsRef.current;
                  if (gs.currentTurnId === gs.myId && !gs.projectile) {
                    gs.aimAngle = Math.min(85, gs.aimAngle + 5);
                    setUiAimAngle(gs.aimAngle);
                  }
                }}
              >
                ↑ NAIK
              </button>
              <div className="text-yellow-300 font-black text-sm bg-black/40 rounded-lg px-2 py-[1px] border border-yellow-500/30 drop-shadow-[0_0_8px_rgba(253,224,71,0.5)] leading-none">
                {uiAimAngle}°
              </div>
              <button
                className="flex-1 w-full rounded-xl bg-white/10 border border-white/20 active:bg-white/30 active:scale-95 text-white text-xs font-black shadow-lg flex items-center justify-center transition-all backdrop-blur-md"
                onClick={() => {
                  playSound("select");
                  const gs = gsRef.current;
                  if (gs.currentTurnId === gs.myId && !gs.projectile) {
                    gs.aimAngle = Math.max(5, gs.aimAngle - 5);
                    setUiAimAngle(gs.aimAngle);
                  }
                }}
              >
                ↓ TURUN
              </button>
            </div>

            {/* Throw — hold to charge, release to throw */}
            <button
              className="flex-1 rounded-2xl bg-linear-to-b from-orange-400 to-red-600 active:from-red-600 active:to-red-800 text-white font-black shadow-[0_0_20px_rgba(249,115,22,0.4)] active:scale-95 touch-none flex flex-col items-center justify-center gap-1 transition-all border border-white/20"
              onPointerDown={(e) => {
                playSound("select");
                mobileStartCharge(e as any);
              }}
              onPointerUp={mobileReleaseThrow}
              onPointerCancel={mobileCancelCharge}
            >
              <span className="text-lg tracking-wider uppercase drop-shadow-md">💨 LEMPAR</span>
              <span className="text-[9px] font-bold text-white/80 uppercase tracking-widest bg-black/20 px-2 py-0.5 rounded-full">
                Tahan → Lepas
              </span>
            </button>
          </div>

          {/* Row 2: Power-up selector */}
          <div className="flex gap-2">
            {[
              { key: "big" as PowerUpKey, icon: "🔥", label: "Big +DMG" },
              { key: "double" as PowerUpKey, icon: "✌️", label: "2× Lempar" },
              { key: "explosive" as PowerUpKey, icon: "💣", label: "Ledak" },
            ].map(({ key, icon, label }) => {
              const me = uiPlayers.find((p) => p.id === uiMyId);
              const hasIt = me?.powerUps[key] ?? false;
              const isSelected = mobileSelectedPU === key;
              return (
                <button
                  key={key}
                  onClick={() => {
                    playSound("select");
                    mobilePUSelect(key);
                  }}
                  disabled={!hasIt}
                  className={`flex-1 py-2.5 rounded-2xl font-black text-[10px] shadow-lg transition-all duration-300 active:scale-95 flex flex-col items-center justify-center gap-1 border backdrop-blur-md uppercase tracking-wider ${
                    !hasIt
                      ? "bg-black/40 border-white/5 text-white/20 cursor-not-allowed grayscale"
                      : isSelected
                        ? "bg-linear-to-b from-yellow-300 to-yellow-500 border-yellow-200 text-black shadow-[0_0_15px_rgba(250,204,21,0.6)] scale-105"
                        : "bg-white/10 border-white/20 text-white hover:bg-white/20"
                  }`}
                >
                  <span className="text-xl drop-shadow-md leading-none">{icon}</span>
                  <span className={isSelected ? "text-black/80" : "text-white/80"}>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Game over */}
      {uiPhase === "gameover" && (
        <div className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-[2rem] p-8 w-full max-w-md text-white shadow-2xl text-center relative overflow-hidden">
          <div className="absolute top-0 right-0 w-40 h-40 bg-yellow-500/30 blur-[50px] rounded-full pointer-events-none -mr-10 -mt-10" />
          <div className="absolute bottom-0 left-0 w-40 h-40 bg-emerald-500/30 blur-[50px] rounded-full pointer-events-none -ml-10 -mb-10" />

          <div className="text-6xl mb-4 drop-shadow-xl animate-bounce">
            {uiWinnerTeam === "cat"
              ? "🐱"
              : uiWinnerTeam === "dog"
                ? "🐶"
                : "🏆"}
          </div>
          <h2 className="text-3xl font-black mb-1 drop-shadow-lg text-transparent bg-clip-text bg-linear-to-br from-white to-gray-400">{uiWinner} Menang!</h2>
          <p className="text-white/50 text-sm mb-6 font-medium">
            Cat vs Dog Battle Selesai
          </p>
          
          <div className="flex flex-col gap-3 mb-6 relative z-10">
            {[...uiPlayers]
              .sort(
                (a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0) || b.hp - a.hp,
              )
              .map((p) => {
                const isWinnerRow = uiWinnerTeam
                  ? p.character === uiWinnerTeam
                  : p.id === uiWinnerId;
                return (
                  <div
                    key={p.id}
                    className={`flex items-center gap-4 rounded-2xl px-5 py-3 transition-transform ${isWinnerRow ? "bg-yellow-400/20 border border-yellow-400/50 shadow-[0_0_15px_rgba(250,204,21,0.2)] scale-[1.02]" : "bg-black/40 border border-white/5"}`}
                  >
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 ${isWinnerRow ? 'bg-yellow-400/30' : 'bg-white/10'}`}>
                      {p.character === "cat" ? "🐱" : "🐶"}
                    </div>
                    <span className="font-bold text-base flex-1 text-left truncate">
                      {p.username}
                      {uiWinnerTeam && p.character === uiWinnerTeam && (
                        <span className="text-yellow-400 text-sm ml-2" title="Winner">🏆</span>
                      )}
                    </span>
                    <div className={`px-3 py-1 rounded-lg text-sm font-black ${p.alive ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                      {p.alive ? `${p.hp} HP` : "💀 MATI"}
                    </div>
                  </div>
                );
              })}
          </div>
          
          <div className="bg-black/20 rounded-xl p-3 mb-5 relative z-10">
            <div className="text-white/80 text-sm font-bold mb-1">
              Rematch Votes
            </div>
            <div className="flex items-center justify-center gap-2">
              <div className="w-full bg-white/10 h-2 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-linear-to-r from-emerald-400 to-green-400 transition-all duration-500" 
                  style={{ width: `${rematchVotes.total > 0 ? (rematchVotes.votes / rematchVotes.total) * 100 : 0}%` }}
                />
              </div>
              <span className="text-xs font-mono font-bold text-white/60">{rematchVotes.votes}/{rematchVotes.total}</span>
            </div>
          </div>

          <div className="relative z-10">
            {!voted ? (
              <button
                onClick={() => {
                  socketRef.current?.emit("battle_vote_rematch");
                  setVoted(true);
                }}
                className="w-full py-4 bg-linear-to-r from-green-500 to-emerald-500 hover:from-green-400 hover:to-emerald-400 text-white font-black text-lg rounded-2xl transition-all active:scale-95 shadow-[0_5px_20px_rgba(16,185,129,0.3)] mb-4"
              >
                🔄 Main Lagi!
              </button>
            ) : (
              <div className="w-full py-4 bg-white/5 border border-white/10 rounded-2xl mb-4">
                <p className="text-green-400 font-bold">
                  ✓ Votemu tercatat — menunggu yang lain...
                </p>
              </div>
            )}
            <a
              href="/lobby"
              className="inline-block text-white/50 hover:text-white text-sm font-bold underline transition-colors"
            >
              ← Kembali ke Lobby
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
