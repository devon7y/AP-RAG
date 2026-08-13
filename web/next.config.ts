import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";

const basePath = process.env.IS_DEMO === "1" ? "/demo" : "";

const nextConfig: NextConfig = {
  ...(basePath
    ? {
        basePath,
        assetPrefix: "/demo-assets",
        redirects: async () => [
          {
            source: "/",
            destination: basePath,
            permanent: false,
            basePath: false,
          },
        ],
      }
    : {}),
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  // Atlas API routes read local JSON tables at runtime (readFileSync from
  // process.cwd()); make sure they ship inside the serverless function bundle.
  outputFileTracingIncludes: {
    "/api/atlas/semantle-author": [
      "./server-data/author_game.json",
      "./public/data/papers.json",
    ],
  },
  // pdf.js reads an uploaded paper's text server-side (app/(chat)/api/uploads). Bundling
  // it breaks that: its Node path dynamically imports its own worker file by relative
  // path, which does not survive into the build output ("Setting up fake worker failed").
  // Kept external, it is required from node_modules at runtime and resolves normally.
  serverExternalPackages: ["pdfjs-dist"],
  cacheComponents: true,
  devIndicators: false,
  poweredByHeader: false,
  reactCompiler: true,
  logging: {
    fetches: {
      fullUrl: false,
    },
    incomingRequests: false,
  },
  images: {
    remotePatterns: [
      {
        hostname: "avatar.vercel.sh",
      },
      {
        protocol: "https",
        hostname: "*.public.blob.vercel-storage.com",
      },
    ],
  },
  experimental: {
    prefetchInlining: true,
    cachedNavigations: true,
    appNewScrollHandler: true,
    inlineCss: true,
    turbopackFileSystemCacheForDev: true,
  },
};

export default withBotId(nextConfig);
