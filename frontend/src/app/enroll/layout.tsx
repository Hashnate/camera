import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Face enrolment | WorkSight',
  description: 'Set up face recognition for automatic attendance.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

export default function EnrollLayout({ children }: { children: React.ReactNode }) {
  return children;
}
