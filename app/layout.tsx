import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { PwaRegister } from "./pwa-register";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const image = new URL("/og.png", base);

  return {
    metadataBase: base,
    title: "Dawar Todo",
    description: "A fast, focused personal task list.",
    applicationName: "Dawar Todo",
    manifest: "/manifest.webmanifest",
    themeColor: "#216e4e",
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: "Dawar Todo",
    },
    icons: {
      icon: [
        { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    openGraph: {
      title: "Dawar Todo",
      description: "Capture what needs doing. Then move.",
      type: "website",
      images: [{ url: image, width: 1672, height: 941, alt: "Dawar Todo" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Dawar Todo",
      description: "Capture what needs doing. Then move.",
      images: [image],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body><PwaRegister />{children}</body>
    </html>
  );
}
