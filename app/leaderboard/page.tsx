"use client";
import { useEffect, useState } from "react";

interface LeaderboardEntry {
  username: string;
  best_score: number;
  games_played: number;
}

export default function LeaderboardPage() {
  const [data, setData] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((d) => {
        setData(d.leaderboard || []);
        setLoading(false);
      });
  }, []);

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-linear-to-br from-pink-400 via-fuchsia-400 to-rose-400 p-4">
      <div className="bg-white/20 backdrop-blur-md rounded-3xl p-8 shadow-2xl w-full max-w-lg">
        <div className="text-center mb-6">
          <div className="text-5xl mb-2">🏆</div>
          <h1 className="text-3xl font-extrabold text-white">Leaderboard</h1>
          <p className="text-white/70 text-sm mt-1">Top 20 pemain terbaik</p>
        </div>

        {loading ? (
          <div className="text-center text-white text-xl animate-pulse py-10">
            Memuat...
          </div>
        ) : data.length === 0 ? (
          <div className="text-center text-white/70 py-10">
            Belum ada data. Jadilah yang pertama! 🐷
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl">
            <table className="w-full">
              <thead>
                <tr className="bg-white/20 text-white text-sm">
                  <th className="py-2 px-3 text-left">#</th>
                  <th className="py-2 px-3 text-left">Username</th>
                  <th className="py-2 px-3 text-right">Best Score</th>
                  <th className="py-2 px-3 text-right">Games</th>
                </tr>
              </thead>
              <tbody>
                {data.map((entry, i) => (
                  <tr
                    key={i}
                    className={`border-t border-white/10 transition ${i < 3 ? "bg-white/15" : "bg-white/5"} hover:bg-white/20`}
                  >
                    <td className="py-2 px-3 text-white font-bold">
                      {medals[i] || i + 1}
                    </td>
                    <td className="py-2 px-3 text-white font-semibold">
                      {entry.username}
                    </td>
                    <td className="py-2 px-3 text-right text-yellow-200 font-bold">
                      {entry.best_score}
                    </td>
                    <td className="py-2 px-3 text-right text-white/60 text-sm">
                      {entry.games_played}x
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-6 flex gap-3 justify-center">
          <a
            href="/lobby"
            className="px-5 py-2 bg-pink-500 hover:bg-pink-400 text-white font-bold rounded-xl transition active:scale-95"
          >
            🎮 Main Lagi
          </a>
          <button
            onClick={() => {
              setLoading(true);
              fetch("/api/leaderboard")
                .then((r) => r.json())
                .then((d) => {
                  setData(d.leaderboard || []);
                  setLoading(false);
                });
            }}
            className="px-5 py-2 bg-white/20 hover:bg-white/30 text-white font-bold rounded-xl transition active:scale-95"
          >
            🔄 Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
