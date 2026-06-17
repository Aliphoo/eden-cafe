import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Eden Blog CMS',
  description: 'ระบบจัดการบทความ SEO, AEO และ GEO สำหรับ Eden Cafe'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
