/** @type {import('next').NextConfig} */

// Where this Next server reaches the backend. Phones never talk to the backend directly:
// they load pages from this server, which forwards the public enrolment calls below.
const BACKEND_INTERNAL_URL = (process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');

const nextConfig = {
  reactStrictMode: false, // Prevents duplicate double-mount video element teardown during testing
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
  experimental: {
    // Enrolment submit embeds three photos in the AI service; allow more than the 30s default.
    proxyTimeout: 120_000,
  },
  async rewrites() {
    return [
      // QR-code phone self-enrolment (token-protected, no login). Only these routes are exposed.
      {
        source: '/api/public/enroll/:path*',
        destination: `${BACKEND_INTERNAL_URL}/api/public/enroll/:path*`,
      },
    ];
  },
};

export default nextConfig;
