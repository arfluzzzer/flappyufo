"use client";
import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";

const LemparTelur = dynamic(() => import("@/components/LemparTelur"), { ssr: false });

interface User { id: number; username: string; pigColor?: string; character?: string; }

function LemparTelurInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const roomId = searchParams?.get("room") || "";

  useEffect(() => {
    const stored = localStorage.getItem("fp_user");
    if (!stored) { router.push("/"); return; }
    setUser(JSON.parse(stored));
  }, [router]);

  useEffect(() => {
    const h = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  function toggleFullscreen() {
    if (!document.fullscreenElement) wrapRef.current?.requestFullscreen();
    else document.exitFullscreen();
  }

  if (!roomId) return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-900 to-indigo-900">
      <div className="text-white text-center">
        <p className="text-2xl font-bold mb-2">❌ Room tidak ditemukan</p>
        <a href="/lobby" className="text-yellow-400 underline">← Kembali ke Lobby</a>
      </div>
    </div>
  );

  if (!user) return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-900 to-indigo-900">
      <div className="text-white text-2xl font-bold animate-pulse">Loading...</div>
    </div>
  );

  return (
    <div ref={wrapRef} className={`min-h-screen flex flex-col items-center justify-start bg-gradient-to-br from-purple-900 via-indigo-900 to-fuchsia-900 pt-2 pb-4 px-2 ${isFullscreen ? "justify-center" : ""}`}>
      <div className="mb-2 flex items-center gap-3 w-full max-w-[820px]">
        <a href="/lobby" className="text-white/70 hover:text-white text-sm underline shrink-0">← Lobby</a>
        <span className="text-white font-bold text-base flex-1 text-center">🥚 Lempar Telur{roomId === "solo" ? " — Solo" : ""}</span>
        {roomId !== "solo" && <span className="bg-white/20 text-yellow-200 text-xs font-mono font-bold px-2 py-1 rounded-full shrink-0">{roomId}</span>}
        <button onClick={toggleFullscreen} className="text-white/60 hover:text-white text-lg shrink-0 transition" title="Fullscreen">
          {isFullscreen ? "⛶" : "⛶"}
        </button>
      </div>
      <LemparTelur
        roomId={roomId}
        username={user.username}
        pigColor={user.pigColor || "pink"}
        character={user.character || "pig"}
      />
    </div>
  );
}

export default function LemparTelurPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-900 to-indigo-900">
        <div className="text-white text-2xl font-bold animate-pulse">Loading...</div>
      </div>
    }>
      <LemparTelurInner />
    </Suspense>
  );
}
