"use client";
import { useEffect, useState, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Suspense } from "react";

const Game = dynamic(() => import("@/components/Game"), { ssr: false });

interface User {
  id: number;
  username: string;
  pigColor?: string;
  character?: string;
}

function GamePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isFs, setIsFs] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mode = searchParams?.get("mode") || "solo";
  const roomId = searchParams?.get("room") || "solo-room";
  const initialSpeed = parseFloat(searchParams?.get("speed") || "3");
  const roomPassword = searchParams?.get("pw") || "";

  useEffect(() => {
    const stored = localStorage.getItem("fp_user");
    if (!stored) { router.push("/"); return; }
    setUser(JSON.parse(stored));
  }, [router]);

  useEffect(() => {
    const h = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  function toggleFs() {
    if (!document.fullscreenElement) wrapRef.current?.requestFullscreen();
    else document.exitFullscreen();
  }

  if (!user)
    return (
      <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-pink-400 to-rose-400">
        <div className="text-white text-2xl font-bold animate-pulse">
          Loading...
        </div>
      </div>
    );

  return (
    <div ref={wrapRef} className="min-h-screen flex flex-col items-center justify-start bg-linear-to-br from-purple-700 via-fuchsia-600 to-pink-500 pt-2 pb-4 px-2">
      <div className="mb-2 flex items-center gap-3 w-full max-w-[800px]">
        <a href="/lobby" className="text-white/70 hover:text-white text-sm underline shrink-0">← Lobby</a>
        <span className="text-white font-bold text-base flex-1 text-center truncate">
          {mode === "baby" ? "👶 Baby Dino" : "🐷 Flappy Pig"} {mode.startsWith("multi") ? "— Multi" : "— Solo"}
        </span>
        {(mode === "multi" || mode === "multi-dino") && (
          <span className="bg-white/20 text-yellow-200 text-xs font-mono font-bold px-2 py-1 rounded-full shrink-0 max-w-[100px] truncate">{roomId}</span>
        )}
        <a href="/leaderboard" className="text-white/70 hover:text-white text-sm underline shrink-0">🏆</a>
        <button onClick={toggleFs} className="text-white/60 hover:text-white text-lg shrink-0 transition" title="Fullscreen">
          {isFs ? "⛶" : "⛶"}
        </button>
      </div>
      <Game
        username={user.username}
        userId={user.id}
        roomId={roomId}
        solo={mode === "solo" || mode === "baby"}
        dinoMode={mode === "baby" || mode === "multi-dino"}
        pigColor={user.pigColor || "pink"}
        character={user.character || "pig"}
        initialSpeed={initialSpeed}
        password={roomPassword}
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
