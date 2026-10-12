import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { publicTeams, readTeam, acceptTeamOperation, teamTool } from '../bot-bridge/teams.mjs';
import { teamProfileContext } from '../bot-bridge/profiles.mjs';
import { fingerprint, id } from './protocol.mjs';

export const TEAM_READS = new Set(['teams.list', 'teams.read']);
export const TEAM_MUTATIONS = new Set(['teams.save', 'teams.assign', 'teams.reorder', 'teams.orderBots', 'teams.memory', 'teams.delete']);

/** Membership and shared memory belong to the hub, independently of native work. */
export class HubTeams {
  constructor(controls, owner, root) {
    this.controls = controls;
    this.owner = owner?.key ?? null;
    this.root = root ?? join(dirname(controls.storePath), 'workspaces');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const store = Object.assign(Object.create(controls.store), {
      bots: () => controls.store.bots().filter(bot => this.owns(bot.id)),
    });
    this.runtime = {
      root: this.root, store,
      saveBot: (bot, changes) => controls.store.saveBot({ ...controls.store.bot(bot.id), ...changes }),
      emitEvent: () => this.publish(),
    };
  }
  owns(botId) {
    if (!this.owner) return false;
    try { return this.controls.hub.placement(this.owner, botId).owner === this.owner; }
    catch { return false; }
  }
  authorize(owner, botId = null) {
    if (!this.owner || owner !== this.owner) throw Object.assign(Error('Teams belong to the authenticated hub owner.'), { outcome: 'rejected' });
    if (botId) this.controls.scope(owner, botId);
  }
  catalog(owner) { this.authorize(owner); return publicTeams(this.runtime); }
  publish() {
    const bots = this.runtime.store.bots();
    if (!bots.length) return;
    this.controls.emitEvent('teams', {
      teams: publicTeams(this.runtime),
      placements: bots.map(bot => ({ id: bot.id, teamId: bot.teamId ?? null, teamOrder: bot.teamOrder ?? 0 })),
    }, bots[0].id);
  }
  async request(owner, { method, botId, params = {}, operationId }, caller = { kind: 'owner' }) {
    this.authorize(owner, botId);
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw Object.assign(Error('Invalid team parameters.'), { outcome: 'rejected' });
    const scoped = caller.kind === 'authenticated-node-tool' && caller.botId === botId && botId;
    if (caller.kind !== 'owner' && (!scoped || method !== 'teams.memory')) throw Object.assign(Error('Team membership is managed by the owner.'), { outcome: 'rejected' });
    if (method === 'teams.list') return this.catalog(owner);
    if (method === 'teams.read') return readTeam(this.runtime, params.id);
    if (!TEAM_MUTATIONS.has(method) || !id(operationId)) throw Object.assign(Error('Original team operation identity required.'), { outcome: 'rejected' });
    const validate = () => {
      this.authorize(owner, botId);
      if(scoped){const {p}=this.controls.scope(owner,botId);if(p.node_id!==caller.nodeId||p.epoch!==caller.epoch)throw Object.assign(Error('The original assigned team caller changed.'),{outcome:'rejected'});}
      if (method === 'teams.assign') this.controls.scope(owner, params.botId);
      if (method === 'teams.orderBots' && Array.isArray(params.ids)) for (const value of params.ids) this.controls.scope(owner, value);
      if (scoped && (this.controls.store.bot(botId).archived || this.controls.store.bot(botId).teamId !== params.id)) throw Object.assign(Error('Shared memory belongs to this bot’s current team.'), { outcome: 'rejected' });
    };
    return this.controls.lock('teams', async () => {
      this.controls.assertWriter(); validate();
      const binding = fingerprint({ owner, method, botId: botId ?? null, params, caller });
      const prior = this.controls.store.operation(operationId);
      if (prior) {
        if (prior.fingerprint !== binding) throw Object.assign(Error('Original team operation changed.'), { outcome: 'rejected' });
        if (prior.status === 'done') return prior.result;
        throw Object.assign(Error('Original team acceptance is unconfirmed; retain its identity.'), { outcome: 'uncertain' });
      }
      const accepted = await acceptTeamOperation(this.runtime, { method, botId, params, operationId }, binding, () => { this.controls.assertWriter(); validate(); });
      return accepted.result;
    });
  }
  async tool(owner, botId, args, caller) {
    this.authorize(owner, botId);
    if (!args || typeof args !== 'object' || Array.isArray(args) || caller.kind !== 'authenticated-node-tool' || caller.botId !== botId) throw Error('Authenticated assigned team tool required.');
    const check=()=>{const {p,b}=this.controls.scope(owner,botId);if(p.node_id!==caller.nodeId||p.epoch!==caller.epoch||b.archived||b.archiving)throw Error('The assigned team caller is unavailable.');return b;};
    const bot=check(),result=await teamTool({ ...this.runtime, handle: request => this.request(owner, request, caller) }, bot, args);
    if(args.operation==='read'&&result?.id){
      // Profiles remain on the hub. Remote agents receive this bounded,
      // authenticated reference instead of opening a hub path locally.
      const {teamProfile}=await teamProfileContext(result),current=check(),latest=this.controls.store.get('team',result.id);
      if(current.teamId!==result.id||latest?.revision!==result.revision||latest.deletedAt)throw Error('The team changed while reading; read the current team again.');
      if(Buffer.byteLength(teamProfile.value)>900*1024)throw Error('The team profile exceeds its transport bound.');
      return {...result,workspaceScope:'hub',profile:teamProfile};
    }
    return result;
  }
}
