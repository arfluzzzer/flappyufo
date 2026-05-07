import type { NextApiRequest, NextApiResponse } from "next";
import { pool } from "@/lib/db";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "POST") {
    const { userId, score } = req.body as { userId: number; score: number };
    if (!userId || score === undefined)
      return res.status(400).json({ error: "Missing fields" });
    try {
      await pool.query("INSERT INTO scores (user_id, score) VALUES ($1, $2)", [
        userId,
        score,
      ]);
      return res.status(201).json({ ok: true });
    } catch {
      return res.status(500).json({ error: "Server error" });
    }
  }
  return res.status(405).end();
}
