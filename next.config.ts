import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow pages/api + app router hybrid
  serverExternalPackages: ["pg"],

  // Allow ngrok and any tunnel/proxy to access the dev server
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok.io",
    "*.ngrok.app",
    "*.loca.lt",
    "*.trycloudflare.com",
  ],

  // Allow server actions from ngrok origins
  experimental: {
    serverActions: {
      allowedOrigins: [
        "*.ngrok-free.app",
        "*.ngrok.io",
        "*.ngrok.app",
        "*.loca.lt",
        "*.trycloudflare.com",
      ],
    },
  },
};

export default nextConfig;
