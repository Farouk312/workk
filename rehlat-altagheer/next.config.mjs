/** @type {import('next').NextConfig} */
const nextConfig = {
  // The SQLite data layer is server-only. Never let it reach the client bundle.
  serverExternalPackages: ['node:sqlite'],
};

export default nextConfig;
