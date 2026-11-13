import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WorkSight | AI Workplace Attendance & Monitoring',
  description: 'Enterprise AI-powered workplace attendance, occupancy analytics, and live camera monitoring platform.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 antialiased">{children}</body>
    </html>
  );
}

