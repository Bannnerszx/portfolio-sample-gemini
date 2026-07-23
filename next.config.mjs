import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This project sits inside a folder that has other lockfiles above it, so
  // Next's workspace-root inference picks the wrong directory and warns.
  // Pin it to this project.
  outputFileTracingRoot: here,
};

export default nextConfig;
