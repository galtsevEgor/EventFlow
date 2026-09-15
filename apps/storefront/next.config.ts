import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  cacheMaxMemorySize: 0,
  ...(process.env.EVENTFLOW_BUILD_ID ? { deploymentId: process.env.EVENTFLOW_BUILD_ID } : {}),
};

export default config;
