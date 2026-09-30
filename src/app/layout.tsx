import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PR Brain",
  description: "Project memory, workflow, roadmap and change intelligence",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
