import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
