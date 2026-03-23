import { Inter, Merriweather, JetBrains_Mono } from "next/font/google";

export const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  fallback: ["system-ui", "sans-serif"],
  display: "swap",
});

export const merriweather = Merriweather({
  variable: "--font-merriweather",
  weight: ["400", "700"],
  subsets: ["latin"],
  fallback: ["Georgia", "serif"],
  display: "swap",
});

export const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  fallback: ["Consolas", "Monaco", "monospace"],
  display: "swap",
});
