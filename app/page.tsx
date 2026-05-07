"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const PIG_COLOR_OPTIONS = [
  { id: "pink", label: "Pink", hex: "#ffc8d8", accent: "#e8829a" },
  { id: "blue", label: "Biru", hex: "#a8d4ff", accent: "#4a82e8" },
  { id: "purple", label: "Ungu", hex: "#d0a8ff", accent: "#9050e8" },
  { id: "orange", label: "Oranye", hex: "#ffd0a0", accent: "#e88030" },
  { id: "green", label: "Hijau", hex: "#a8f0c0", accent: "#30c870" },
  { id: "yellow", label: "Kuning", hex: "#fff0a0", accent: "#d8c030" },
  { id: "red", label: "Merah", hex: "#ffb0a8", accent: "#e83020" },
  { id: "teal", label: "Teal", hex: "#a0e8e0", accent: "#30a8a0" },
  { id: "white", label: "Putih", hex: "#f4f4f4", accent: "#b0b0b0" },
  { id: "brown", label: "Coklat", hex: "#d4b090", accent: "#906040" },
];

export default function SignupPage() {
  const [username, setUsername] = useState("");
  const [pigColor, setPigColor] = useState("pink");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [leaderboard, setLeaderboard] = useState<
    { username: string; best_score: number }[]
  >([]);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((d) => setLeaderboard((d.leaderboard ?? []).slice(0, 5)))
      .catch(() => {});
  }, []);

  const selectedColor = PIG_COLOR_OPTIONS.find((c) => c.id === pigColor)!;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (username.trim().length < 2) {
      setError("Username minimal 2 karakter");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.error) {
      setError(data.error);
      return;
    }
    localStorage.setItem("fp_user", JSON.stringify({ ...data.user, pigColor }));
    router.push("/lobby");
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-5 bg-linear-to-br from-pink-400 via-fuchsia-400 to-rose-400 px-4 py-8">
      <div className="bg-white/20 backdrop-blur-md rounded-3xl p-10 shadow-2xl w-full max-w-sm">
        <div className="text-center mb-8">
          <div
            className="text-7xl mb-3 animate-bounce inline-block rounded-full p-2"
            style={{ backgroundColor: selectedColor.hex }}
          >
            🐷
          </div>
          <h1 className="text-4xl font-extrabold text-white drop-shadow">
            Ahhhh BABIIII
          </h1>
          <p className="text-white/80 mt-1">Masukkan username untuk bermain</p>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="Username kamu..."
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={20}
            className="px-4 py-3 rounded-xl text-lg font-semibold outline-none bg-white/80 text-gray-700 placeholder-gray-400 focus:ring-4 focus:ring-pink-300"
          />
          {/* Color picker */}
          <div>
            <p className="text-white font-semibold mb-2 text-sm">
              🎨 Warna Babi:{" "}
              <span className="text-yellow-200">{selectedColor.label}</span>
            </p>
            <div className="grid grid-cols-5 gap-2">
              {PIG_COLOR_OPTIONS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setPigColor(c.id)}
                  className="h-9 rounded-xl transition-transform active:scale-90"
                  style={{
                    backgroundColor: c.hex,
                    border: `3px solid ${pigColor === c.id ? c.accent : "transparent"}`,
                    outline: pigColor === c.id ? "2px solid white" : "none",
                    outlineOffset: "1px",
                  }}
                  title={c.label}
                />
              ))}
            </div>
          </div>
          {error && (
            <p className="text-red-200 text-sm font-semibold text-center">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="py-3 bg-pink-500 hover:bg-pink-400 active:scale-95 text-white text-xl font-bold rounded-xl shadow-lg transition disabled:opacity-60"
          >
            {loading ? "Loading..." : "Masuk & Main! 🚀"}
          </button>
        </form>
        <div className="mt-4 text-center">
          <a
            href="/leaderboard"
            className="text-white/70 hover:text-white text-sm underline"
          >
            🏆 Lihat Leaderboard
          </a>
        </div>
      </div>

      {/* Mini leaderboard */}
      {leaderboard.length > 0 && (
        <div className="bg-white/20 backdrop-blur-md rounded-2xl p-5 shadow-xl w-full max-w-sm">
          <h2 className="text-white font-bold text-lg mb-3 text-center">
            🏆 Top Pemain
          </h2>
          <div className="flex flex-col gap-1">
            {leaderboard.map((entry, i) => (
              <div
                key={i}
                className="flex items-center justify-between bg-white/10 rounded-xl px-3 py-1.5"
              >
                <span className="text-white font-semibold">
                  {i === 0
                    ? "🥇"
                    : i === 1
                      ? "🥈"
                      : i === 2
                        ? "🥉"
                        : `#${i + 1}`}{" "}
                  {entry.username}
                </span>
                <span className="text-yellow-200 font-bold">
                  {entry.best_score}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-center">
            <a
              href="/leaderboard"
              className="text-white/60 hover:text-white text-xs underline"
            >
              Lihat semua →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
