/**
 * Bundle entry for `dsh-remote-control`.
 *
 * A profile mounts exactly one role:
 * - `role: controller` on the computer the user sits at — registers `remote_dsh_*` tools.
 * - `role: worker` on the computer to be controlled — serves the LAN bridge and
 *   runs the sessions.
 *
 * The two role entries can also be mounted directly (`lib/worker.js` /
 * `lib/controller.js`); this dispatcher exists so one installed bundle can
 * serve both sides through `config.role`.
 *
 * @module dsh-remote-control
 */

import { apply as applyController, name as controllerName } from './controller.js'
import { apply as applyWorker, name as workerName } from './worker.js'

/** Stable Cordis plugin name of the dispatcher. */
export const name = 'remote-control'

/**
 * Mount the configured role once its required host services exist.
 * @param {import('@deepseek-ai/cordis').Context} ctx context of this profile row.
 * @param {{ role?: 'controller' | 'worker' } & Record<string, unknown>} config row config.
 */
export function apply(ctx, config) {
  const role = config?.role ?? 'controller'
  if (role === 'worker') {
    ctx.inject(['agents'], (workerCtx) => applyWorker(workerCtx, config))
    return
  }
  if (role === 'controller') {
    ctx.inject(['tools'], (controllerCtx) => applyController(controllerCtx, config))
    return
  }
  throw new Error(`remote-control: unknown role ${JSON.stringify(role)}; expected "controller" or "worker"`)
}

/** Names exported for diagnostics and for profile tooling that inspects the bundle. */
export { controllerName, workerName }
