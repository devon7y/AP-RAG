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
    // pdf.js reads an uploaded paper by handing the file to a worker module it imports at
    // runtime. Nothing references that module statically, so tracing leaves it out of the
    // function and every upload fails with "Setting up fake worker failed" — which reads,
    // from the composer, as "this file could not be read as a PDF". Ship it explicitly.
    //
    // The path is the pnpm STORE path, not node_modules/pdfjs-dist/… — the latter is a
    // symlink, and a file included through it lands in a symlinked directory, which
    // Vercel rejects when packaging the function ("invalid deployment package"). The
    // store path is also what require.resolve returns at runtime, so it is the file that
    // actually gets imported.
    "/api/uploads": [
      "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
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
