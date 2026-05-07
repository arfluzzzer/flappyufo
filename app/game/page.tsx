"use client";
import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Suspense } from "react";

const Game = dynamic(() => import("@/components/Game"), { ssr: false });

interface User {
  id: number;
  username: string;
  pigColor?: string;
}

function GamePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const mode = searchParams.get("mode") || "solo";
  const roomId = searchParams.get("room") || "solo-room";
  const initialSpeed = parseFloat(searchParams.get("speed") || "3");

  useEffect(() => {
    const stored = localStorage.getItem("fp_user");
    if (!stored) {
      router.push("/");
      return;
    }
    setUser(JSON.parse(stored));
  }, [router]);

  if (!user)
    return (
      <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-pink-400 to-rose-400">
        <div className="text-white text-2xl font-bold animate-pulse">
          Loading...
        </div>
      </div>
    );

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-linear-to-br from-pink-400 via-fuchsia-400 to-rose-400 p-4">
      <div className="mb-3 flex items-center gap-4">
        <a
          href="/lobby"
          className="text-white/70 hover:text-white text-sm underline"
        >
          ← Lobby
        </a>
        <span className="text-white font-bold text-lg">🐷 Ahhhh BABIIII</span>
        {mode === "multi" && (
          <span className="bg-white/20 text-yellow-200 text-sm font-mono font-bold px-3 py-1 rounded-full">
            Room: {roomId}
          </span>
        )}
        <a
          href="/leaderboard"
          className="text-white/70 hover:text-white text-sm underline"
        >
          🏆 Board
        </a>
      </div>
      <Game
        username={user.username}
        userId={user.id}
        roomId={roomId}
        solo={mode === "solo"}
        pigColor={user.pigColor || "pink"}
        initialSpeed={initialSpeed}
      />
    </div>
  );
}

export default function GamePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-pink-400 to-rose-400">
          <div className="text-white text-2xl font-bold animate-pulse">
            Loading...
          </div>
        </div>
      }
    >
      <GamePageInner />
    </Suspense>
  );
}
