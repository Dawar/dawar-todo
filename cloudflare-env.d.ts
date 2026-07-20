declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    API_TOKEN_ENCRYPTION_KEY: string;
    S3_ACCESS_KEY: string;
    S3_ACCESS_KEY_ID: string;
    S3_BUCKET: string;
    S3_CDN_URL: string;
    S3_ENDPOINT_URL: string;
  }
}
