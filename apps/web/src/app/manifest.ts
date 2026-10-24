import type { MetadataRoute } from "next";

/** Makes open-bot installable on phones and desktops, with its own window and icon. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "open-bot",
    short_name: "open-bot",
    description: "Your AI teammates and the computer they share.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f3f4f6",
    theme_color: "#14161b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
