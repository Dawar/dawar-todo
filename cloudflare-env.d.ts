declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BOTS_OWNER_EMAIL?: string;
    BOTS_OWNER_USER_ID?: string;
    BOTS_RELAY_URL?: string;
    BOTS_MACHINE_ID?: string;
    BOTS_TICKET_SECRET?: string;
    BOTS_NOTIFICATION_SECRET?: string;
    BOTS_DEV_AUTH?: string;
    S3_ACCESS_KEY: string;
    S3_ACCESS_KEY_ID: string;
    S3_BUCKET: string;
    S3_CDN_URL: string;
    S3_ENDPOINT_URL: string;
    VAPID_SUBJECT?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    TODO_MAINTENANCE_SECRET?: string;
    OPENAI_API_KEY?: string;
    OPENAI_PROJECT_ID?: string;
    OPENAI_REALTIME_MODEL?: string;
    OPENAI_REALTIME_VOICE?: string;
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_PHONE_NUMBER?: string;
  }
}
