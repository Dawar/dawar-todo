import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function SessionCheck() {
  const requestHeaders = await headers();
  return (
    <main>
      <p>Site user ID: {requestHeaders.get("oai-authenticated-user-id") ?? "Signed out"}</p>
      <p>Site email: {requestHeaders.get("oai-authenticated-user-email") ?? "Signed out"}</p>
    </main>
  );
}
