import type { Metadata } from "next";
import { Manrope, Space_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const spaceMono = Space_Mono({
  variable: "--font-geist-mono",
  weight: ["400", "700"],
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
      className={`${manrope.variable} ${spaceMono.variable} h-full antialiased`}
    >
      <body className="h-full flex flex-col text-foreground">
        <nav className="sticky top-0 z-20 border-b border-[color:var(--line)] bg-white/85 backdrop-blur-lg">
          <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-[color:var(--brand)] text-sm font-extrabold text-white shadow-sm">
                MT
              </span>
              <span>
                <span className="block text-sm font-semibold tracking-tight text-[color:var(--brand-strong)]">
                  IDD Knowledge Chat
                </span>
                <span className="block text-[11px] text-slate-500">MilkTest-style Knowledge Workspace</span>
              </span>
            </Link>
            <div className="flex items-center gap-2 text-sm sm:gap-3">
              <Link
                href="/"
                className="app-pill rounded-full px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-[color:var(--brand-soft)] sm:text-sm"
              >
                Chat
              </Link>
              <Link
                href="/ingest"
                className="app-pill rounded-full px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-[color:var(--brand-soft)] sm:text-sm"
              >
                Documents
              </Link>
              <Link
                href="/help"
                className="app-pill rounded-full px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-[color:var(--brand-soft)] sm:text-sm"
              >
                Help
              </Link>
            </div>
          </div>
        </nav>
        <main className="flex-1 flex flex-col min-h-0">{children}</main>
      </body>
    </html>
  );
}
