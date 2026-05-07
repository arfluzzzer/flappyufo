import type { NextApiRequest, NextApiResponse } from "next";
import { pool } from "@/lib/db";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "GET") {
    try {
      const result = await pool.query(`
        SELECT u.username, MAX(s.score) AS best_score, COUNT(s.id) AS games_played
        FROM users u
        JOIN scores s ON u.id = s.user_id
        GROUP BY u.id, u.username
        ORDER BY best_score DESC
        LIMIT 20
      `);
      return res.status(200).json({ leaderboard: result.rows });
    } catch {
      return res.status(500).json({ error: "Server error" });
    }
  }
  return res.status(405).end();
}
