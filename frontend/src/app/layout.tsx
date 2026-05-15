import type { Metadata } from "next";
import { Inter, EB_Garamond } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const inter = Inter({
    variable: "--font-inter",
    subsets: ["latin"],
});

const ebGaramond = EB_Garamond({
    variable: "--font-eb-garamond",
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
    metadataBase: new URL("https://app.gordonoss.com"),
    title: "Gordon - AI Finance Platform",
    description:
        "Open-source, self-hostable AI platform for finance professionals — diligence, research, and audit-grade citation review.",
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: "https://app.gordonoss.com",
        siteName: "Gordon",
        title: "Gordon - AI Finance Platform",
        description:
            "Open-source, self-hostable AI platform for finance professionals — diligence, research, and audit-grade citation review.",
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: "Gordon",
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: "Gordon - AI Finance Platform",
        description:
            "Open-source, self-hostable AI platform for finance professionals — diligence, research, and audit-grade citation review.",
        images: ["/link-image.jpg"],
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className={`${inter.variable} ${ebGaramond.variable} font-sans antialiased`}
            >
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
