import { build } from 'esbuild';
import { join } from 'node:path';

// The deploy controller and the rehearsal stand-in run from packaged releases,
// which ship bundles rather than individual bot-bridge source modules. Both
// are bundled here and copied over their sources by portable/package.mjs.
export const DEPLOY_BUNDLES = Object.freeze([
  { entry: 'portable/deploy-cli.mjs', file: 'deploy-cli.mjs', check: ['help'] },
  { entry: 'portable/rehearsal-service.mjs', file: 'rehearsal-service.mjs', check: ['--help'] },
]);
export async function buildDeployBundles(outdir, { root = process.cwd() } = {}) {
  for (const bundle of DEPLOY_BUNDLES)
    await build({ entryPoints: [join(root, bundle.entry)], outfile: join(outdir, bundle.file), bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', logLevel: 'warning' });
}
