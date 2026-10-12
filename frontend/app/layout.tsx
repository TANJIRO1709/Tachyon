import type { Metadata } from "next";
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tachyon",
  description: "Live view of the Tachyon inference serving layer: batching, semantic cache, circuit breaker.",
};

// Applies a saved theme before first paint so there is no flash.
const themeScript = `try{var t=localStorage.getItem("tachyon-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
