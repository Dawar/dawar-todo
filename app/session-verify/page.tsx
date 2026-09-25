import { env } from "cloudflare:workers";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function SessionCheck() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const ownerId = (env as Cloudflare.Env).BOTS_OWNER_USER_ID;
  return (
    <main>
      <p>Site user ID: {userId ?? "Signed out"}</p>
      <p>Owner ID configured: {ownerId ? "Yes" : "No"}</p>
      <p>Owner ID matches: {ownerId && userId === ownerId ? "Yes" : "No"}</p>
    </main>
  );
}
