import type { NextApiRequest, NextApiResponse } from "next";
import { pool, initDB } from "@/lib/db";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await initDB();

  if (req.method === "POST") {
    const { username } = req.body as { username: string };
    if (!username || username.trim().length < 2) {
      return res.status(400).json({ error: "Username minimal 2 karakter" });
    }
    const clean = username
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    if (!clean) return res.status(400).json({ error: "Username tidak valid" });

    try {
      const existing = await pool.query(
        "SELECT id, username FROM users WHERE username=$1",
        [clean],
      );
      if (existing.rows.length > 0) {
        return res.status(200).json({ user: existing.rows[0], new: false });
      }
      const result = await pool.query(
        "INSERT INTO users (username) VALUES ($1) RETURNING id, username",
        [clean],
      );
      return res.status(201).json({ user: result.rows[0], new: true });
    } catch {
      return res.status(500).json({ error: "Server error" });
    }
  }

  return res.status(405).end();
}
