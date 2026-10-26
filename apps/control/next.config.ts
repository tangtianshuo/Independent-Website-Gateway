import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_TEST_BUILD ? '.next-test' : '.next',
};

export default nextConfig;
