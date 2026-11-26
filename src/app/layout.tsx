import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Astrum BPO Financeiro" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
