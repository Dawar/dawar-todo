import { botsOwner } from '../lib/bots-auth';
import { agentInstallerArchive } from './agent-installer-archive';

type Environment = { BOTS_OWNER_EMAIL?: string; BOTS_OWNER_USER_ID?: string };
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
let verifiedArchive: Promise<Uint8Array<ArrayBuffer>> | undefined;

function archive() {
  verifiedArchive ??= (async () => {
    const bytes = Uint8Array.from(atob(agentInstallerArchive.base64), c => c.charCodeAt(0));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const sha256 = Array.from(hash, value => value.toString(16).padStart(2, '0')).join('');
    if (bytes.length !== agentInstallerArchive.bytes || sha256 !== agentInstallerArchive.sha256) {
      throw Error('Installer integrity check failed.');
    }
    return bytes;
  })();
  return verifiedArchive;
}

// The immutable archive is bundled inside the authenticated Worker, not a
// publicly addressable static asset. No node enrollment or native call occurs.
export async function agentInstallerResponse(request: Request, environment: Environment): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/portable/installer' && path !== '/api/portable/installer/download') return null;
  try {
    botsOwner(request, {
      BOTS_OWNER_EMAIL: environment.BOTS_OWNER_EMAIL,
      BOTS_OWNER_USER_ID: environment.BOTS_OWNER_USER_ID,
    });
    const ownerId = environment.BOTS_OWNER_USER_ID?.trim();
    if (!ownerId || request.headers.get('oai-authenticated-user-id')?.trim() !== ownerId) throw Error('Owner required.');
  } catch {
    return Response.json({ error: 'Sign in as the owner to download the installer.' }, { status: 403, headers });
  }
  if (request.method !== 'GET') {
    return Response.json({ error: 'Use GET to download the installer.' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
  }
  try {
    const bytes = await archive();
    if (path.endsWith('/download')) {
      return new Response(bytes, { headers: {
        ...headers,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${agentInstallerArchive.name}"`,
        'Content-Length': String(bytes.length),
      } });
    }
    return Response.json({
      source: agentInstallerArchive.source,
      sha256: agentInstallerArchive.sha256,
      bytes: bytes.length,
      href: '/api/portable/installer/download',
      enrollmentAvailable: false,
    }, { headers });
  } catch {
    return Response.json({ error: 'Installer is temporarily unavailable.' }, { status: 503, headers });
  }
}
