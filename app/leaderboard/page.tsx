"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface LeaderboardEntry {
  username: string;
  best_score: number;
  games_played: number;
}

const GAME_OPTIONS = [
  { key: "", label: "Semua" },
  { key: "flappy_solo", label: "Flappy Solo" },
  { key: "baby_solo", label: "Baby Dino Solo" },
  { key: "egg_solo", label: "Lempar Telur Solo" },
];

const VALID_GAME_KEYS = new Set(GAME_OPTIONS.map((g) => g.key));

import { Suspense } from "react";

export default function LeaderboardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">Loading...</div>}>
      <LeaderboardContent />
    </Suspense>
  );
}

function LeaderboardContent() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGame, setSelectedGame] = useState("");

  useEffect(() => {
    const game = (searchParams?.get("game") || "").trim().toLowerCase();
    setSelectedGame(VALID_GAME_KEYS.has(game) ? game : "");
  }, [searchParams]);

  useEffect(() => {
    let active = true;

    async function loadLeaderboard() {
      setLoading(true);
      const qs = selectedGame
        ? `?game=${encodeURIComponent(selectedGame)}&limit=20`
        : "?limit=20";
      const r = await fetch(`/api/leaderboard${qs}`);
      const d = await r.json();
      if (active) {
        setData(d.leaderboard || []);
        setLoading(false);
      }
    }

    loadLeaderboard().catch(() => setLoading(false));
    return () => {
      active = false;
    };
  }, [selectedGame]);

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-950 px-4 py-8 relative overflow-hidden font-sans">
      {/* Dynamic Background Elements */}
      <div className="absolute top-[-10%] left-[-10%] w-[60vw] h-[60vw] bg-pink-600/20 blur-[120px] rounded-full pointer-events-none mix-blend-screen" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[60vw] h-[60vw] bg-purple-600/20 blur-[120px] rounded-full pointer-events-none mix-blend-screen" />
      <div className="absolute top-[30%] left-[20%] w-[40vw] h-[40vw] bg-yellow-500/10 blur-[100px] rounded-full pointer-events-none mix-blend-screen" />

      <div className="bg-black/40 backdrop-blur-2xl border border-white/10 rounded-[2rem] p-8 shadow-2xl w-full max-w-2xl relative z-10 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="text-center mb-6 shrink-0">
          <div className="text-6xl mb-3 animate-bounce inline-block drop-shadow-2xl">🏆</div>
          <h1 className="text-4xl font-black text-transparent bg-clip-text bg-linear-to-r from-yellow-300 to-pink-400 drop-shadow-lg uppercase tracking-widest">
            Hall of Fame
          </h1>
          <p className="text-white/60 text-xs mt-2 font-bold uppercase tracking-widest">
            Top Pemain Terbaik Per Mode
          </p>
        </div>

        {/* Filters */}
        <div className="mb-6 flex flex-wrap gap-2 justify-center shrink-0">
          {GAME_OPTIONS.map((opt) => (
            <button
              key={opt.key || "all"}
              onClick={() => setSelectedGame(opt.key)}
              className={`px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all duration-300 ${
                selectedGame === opt.key
                  ? "bg-linear-to-r from-yellow-400 to-orange-500 text-black shadow-[0_0_15px_rgba(250,204,21,0.5)] scale-105"
                  : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white border border-white/5"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Leaderboard List */}
        <div className="flex-1 overflow-y-auto min-h-[300px] pr-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-white/5 [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-thumb]:rounded-full">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full text-white/50 text-sm font-bold uppercase tracking-widest animate-pulse">
              <div className="text-4xl mb-4">⏳</div>
              Menyinkronkan Data...
            </div>
          ) : data.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-white/50 text-sm font-bold uppercase tracking-widest">
              <div className="text-4xl mb-4 opacity-50">🛸</div>
              Belum ada data. Jadilah yang pertama!
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex px-4 py-2 text-[10px] font-black text-white/40 uppercase tracking-widest border-b border-white/5">
                <div className="w-12 text-center">Rank</div>
                <div className="flex-1">Pemain</div>
                <div className="w-24 text-right">Skor</div>
                <div className="w-20 text-right">Main</div>
              </div>
              {data.map((entry, i) => (
                <div
                  key={i}
                  className={`flex items-center px-4 py-3 rounded-2xl transition-all duration-300 border ${
                    i === 0
                      ? "bg-yellow-500/10 border-yellow-500/30 shadow-[0_0_15px_rgba(234,179,8,0.15)]"
                      : i === 1
                      ? "bg-slate-300/10 border-slate-300/30"
                      : i === 2
                      ? "bg-amber-700/10 border-amber-700/30"
                      : "bg-white/5 border-white/5 hover:bg-white/10"
                  }`}
                >
                  <div className="w-12 text-center font-black text-xl">
                    {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : <span className="text-white/40 text-sm">{i + 1}</span>}
                  </div>
                  <div className="flex-1 font-bold text-white text-sm truncate">
                    {entry.username}
                  </div>
                  <div className="w-24 text-right font-black text-yellow-300 drop-shadow-[0_0_8px_rgba(253,224,71,0.5)]">
                    {entry.best_score}
                  </div>
                  <div className="w-20 text-right text-[11px] font-bold text-white/40 uppercase tracking-wider">
                    {entry.games_played}x
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="mt-6 pt-5 border-t border-white/10 flex flex-wrap gap-3 justify-center shrink-0">
          <a
            href="/lobby"
            className="px-6 py-3 bg-linear-to-r from-pink-500 to-rose-500 hover:from-pink-400 hover:to-rose-400 text-white text-[11px] font-black uppercase tracking-widest rounded-xl shadow-[0_0_15px_rgba(236,72,153,0.3)] transition-all active:scale-95 flex items-center gap-2"
          >
            <span className="text-base">🎮</span> Kembali ke Lobby
          </a>
          <button
            onClick={() => {
              setLoading(true);
              const qs = selectedGame
                ? `?game=${encodeURIComponent(selectedGame)}&limit=20`
                : "?limit=20";
              fetch(`/api/leaderboard${qs}`)
                .then((r) => r.json())
                .then((d) => {
                  setData(d.leaderboard || []);
                  setLoading(false);
                });
            }}
            className="px-6 py-3 bg-white/5 border border-white/10 hover:bg-white/10 text-white/70 hover:text-white text-[11px] font-black uppercase tracking-widest rounded-xl transition-all active:scale-95 flex items-center gap-2"
          >
            <span className="text-base">🔄</span> Refresh Data
          </button>
        </div>
      </div>
    </div>
  );
}
