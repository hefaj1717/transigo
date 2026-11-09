import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { isIndexable } from "@/lib/public/seo";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");

export const metadata: Metadata = {
  ...(appUrl ? { metadataBase: new URL(appUrl) } : {}),
  title: "Transigo",
  description: "Trasporti, facchinaggio, imballaggio e deposito merci",
  openGraph: { siteName: "Transigo", locale: "it_IT", type: "website" },
  // D126: only production (SITE_INDEXING=on) is indexed.
  robots: isIndexable() ? { index: true, follow: true } : { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="it"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
