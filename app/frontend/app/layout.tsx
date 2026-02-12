import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SolanID Console",
  description: "Minimal dark interface for SolanID protocol operations",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
