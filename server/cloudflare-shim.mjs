// Native host for the same Garage implementation used by Cloudflare Workers.
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
