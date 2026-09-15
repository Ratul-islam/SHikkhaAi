const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Proxies API calls through this app's own origin so the backend's
    // HttpOnly refresh cookie becomes first-party here too — otherwise the
    // browser would never attach it to requests made from a different
    // origin/port, and neither the Axios client nor Middleware could see it.
    return [
      {
        source: "/api/:path*",
        destination: `${API_PROXY_TARGET}/api/:path*`,
      },
      // Narration MP3s (and their timestamp manifests) are written by
      // edge-speech.service.ts and served by Fastify's static plugin at
      // :4000/uploads/. The video player asks for them by the root-relative
      // path the API hands back ("/uploads/<uuid>.mp3"), which the browser
      // resolves against THIS origin — so without this rewrite every lesson
      // played silently: Remotion's <Audio> gets a 404 and fails without
      // surfacing an error. Same-origin also keeps range requests (audio
      // seeking) straightforward.
      {
        source: "/uploads/:path*",
        destination: `${API_PROXY_TARGET}/uploads/:path*`,
      },
      // Generated lesson clips when MEDIA_STORE=local. Same cross-origin trap
      // as /uploads: the player asks this origin for the path the API returns.
      // With R2/Cloudinary the API returns an absolute CDN URL and this rewrite
      // is simply unused.
      {
        source: "/media/:path*",
        destination: `${API_PROXY_TARGET}/media/:path*`,
      },
    ];
  },
};

export default nextConfig;
