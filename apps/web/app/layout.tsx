import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "STRAYS",
  description: "Feed a stray. It hunts letscash. It brings back what it kills.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
