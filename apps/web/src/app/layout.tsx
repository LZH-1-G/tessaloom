import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Inter } from "next/font/google";
import { connection } from "next/server";
import "@xyflow/react/dist/style.css";
import "./globals.css";

// Self-hosted at build time by next/font: no runtime third-party requests (UI_UX_SPEC §2.3).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Tessaloom", template: "%s · Tessaloom" },
  description: "An agentic cultural experimentation studio.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Every page renders per request so Next can apply the proxy's CSP nonce (SECURITY §7).
  await connection();
  return (
    <html
      lang="en"
      className={`${inter.variable} ${fraunces.variable} ${plexMono.variable}`}
    >
      <body>
        <a
          href="#main"
          className="sr-only z-50 rounded bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
