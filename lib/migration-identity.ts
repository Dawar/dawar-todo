import { botsOwner } from './bots-auth';

type MigrationIdentityEnvironment = {
  BOTS_OWNER_EMAIL?: string;
  BOTS_OWNER_USER_ID?: string;
};

const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

// Read the existing binding without enrollment, migration or database writes.
// Development auth, Todo tokens, query values and an email match cannot
// substitute for the platform's exact authenticated user ID.
export function migrationIdentityResponse(request: Request, environment: MigrationIdentityEnvironment) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Use GET for the owner identity readout.' }, {
      status: 405, headers: { ...headers, Allow: 'GET' },
    });
  }
  try {
    const owner = botsOwner(request, {
      BOTS_OWNER_EMAIL: environment.BOTS_OWNER_EMAIL,
      BOTS_OWNER_USER_ID: environment.BOTS_OWNER_USER_ID,
    });
    const userId = environment.BOTS_OWNER_USER_ID?.trim();
    if (!userId || request.headers.get('oai-authenticated-user-id')?.trim() !== userId) {
      throw Error('The authenticated owner identity is required.');
    }
    return Response.json({
      version: 1,
      ownerKey: owner,
      ownerUserId: userId,
      sourceOrigin: new URL(request.url).origin,
      evidenceKind: 'configured-owner-matched-to-authenticated-request',
      identityChanged: false,
    }, { headers });
  } catch {
    return Response.json({ error: 'Open this readout in the existing owner’s signed-in session.' }, {
      status: 403, headers,
    });
  }
}
