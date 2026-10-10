import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "@/styles/globals.css";
import { cx } from "@/utils/cx";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Fava — Spec-first software building",
  description: "Connect GitHub, write specifications, and build software from a clear source of truth.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cx(inter.variable, "h-full antialiased")}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
