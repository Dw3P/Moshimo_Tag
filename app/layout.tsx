import type { Metadata } from 'next';
import './globals.css';

const title = 'Moshimo Tag';
const description = 'Prepare for the moments when a plan does not go as expected.';
const configuredOrigin = process.env.NEXT_PUBLIC_SITE_ORIGIN;
const metadataBase = configuredOrigin ? new URL(configuredOrigin) : undefined;

export const metadata: Metadata = {
  title,
  description,
  metadataBase,
  openGraph: {
    title,
    description,
    type: 'website',
    images: metadataBase
      ? [{ url: '/og.png', width: 1731, height: 909, alt: title }]
      : undefined,
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: metadataBase ? ['/og.png'] : undefined,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
