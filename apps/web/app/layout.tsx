import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Evidence Loop",
  description: "Evidence Loop application shell",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/assets/shell.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
