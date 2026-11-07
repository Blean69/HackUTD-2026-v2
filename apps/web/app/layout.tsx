import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { DataProvider } from "@/components/DataProvider";
import { PITCH, PRODUCT_NAME } from "@/lib/constants";
import "./globals.css";

const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: `${PRODUCT_NAME}: your household's financial room`, template: `%s · ${PRODUCT_NAME}` },
  description: PITCH,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b3a2c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <DataProvider>{children}</DataProvider>
      </body>
    </html>
  );
}
