import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "IDD Knowledge Chat",
  description: "Ask questions about IDD documents and policies",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="h-full flex flex-col bg-slate-950 text-slate-100">
        <nav className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800 bg-slate-900">
          <Link href="/" className="text-sm font-semibold tracking-tight text-slate-100">
            IDD Knowledge Chat
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link
              href="/"
              className="text-slate-400 hover:text-slate-100 transition-colors"
            >
              Chat
            </Link>
            <Link
              href="/ingest"
              className="text-slate-400 hover:text-slate-100 transition-colors"
            >
              Documents
            </Link>
          </div>
        </nav>
        <main className="flex-1 flex flex-col min-h-0">{children}</main>
      </body>
    </html>
  );
}
