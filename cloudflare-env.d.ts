declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    S3_ACCESS_KEY: string;
    S3_ACCESS_KEY_ID: string;
    S3_BUCKET: string;
    S3_CDN_URL: string;
    S3_ENDPOINT_URL: string;
    VAPID_SUBJECT?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    OPENAI_API_KEY?: string;
    OPENAI_PROJECT_ID?: string;
    OPENAI_REALTIME_MODEL?: string;
    OPENAI_REALTIME_VOICE?: string;
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_PHONE_NUMBER?: string;
  }
}
