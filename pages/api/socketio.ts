import type { NextApiRequest } from "next";
import { initSocket, NextApiResponseWithSocket } from "@/lib/socket";

export const config = { api: { bodyParser: false } };

export default function handler(
  req: NextApiRequest,
  res: NextApiResponseWithSocket,
) {
  if (!res.socket.server.io) {
    res.socket.server.io = initSocket(res.socket.server);
  }
  res.end();
}
