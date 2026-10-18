import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "My Reading Travelogue",
  description: "Map the birthplaces of the authors in your Goodreads library.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
