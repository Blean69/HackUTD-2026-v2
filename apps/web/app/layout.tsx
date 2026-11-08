import type { Metadata, Viewport } from "next";
import { Archivo, Geist_Mono, Instrument_Sans } from "next/font/google";
import { DataProvider } from "@/components/DataProvider";
import { THEME_COLOR, THEME_SCRIPT } from "@/components/shell/theme-script";
import { PITCH, PRODUCT_NAME } from "@/lib/constants";
import "./globals.css";

/*
 * Type pairing (docs/design-system.md §3): Instrument Sans for the interface (compact, crisp at 12-14 px, plain tabular
 * zeros), Archivo set expanded for page titles and headline figures (wide, engineered numerals are the product's voice),
 * Geist Mono for ids, models and timings. Archivo is variable on its width axis, so one file covers every width we use.
 */
const ui = Instrument_Sans({ variable: "--font-ui", subsets: ["latin"], display: "swap" });
const display = Archivo({ variable: "--font-disp", subsets: ["latin"], axes: ["wdth"], display: "swap" });
const mono = Geist_Mono({ variable: "--font-code", subsets: ["latin"], display: "swap", preload: false });

export const metadata: Metadata = {
  title: { default: `${PRODUCT_NAME}: your household's financial room`, template: `%s · ${PRODUCT_NAME}` },
  description: PITCH,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme is stamped by THEME_SCRIPT before first paint, so the server and client markup differ on purpose.
    <html lang="en" className={`${ui.variable} ${display.variable} ${mono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <DataProvider>{children}</DataProvider>
      </body>
    </html>
  );
}
