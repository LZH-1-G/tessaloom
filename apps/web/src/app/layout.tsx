import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tessaloom",
  description: "An agentic cultural experimentation studio.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
