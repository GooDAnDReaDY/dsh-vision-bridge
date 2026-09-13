// #291: domain routes barrel
import { registerConfigRoutes } from './config.js'
import { registerDiagnosticRoutes } from './diagnostics.js'
import { registerMaintenanceRoutes } from './maintenance.js'
import { registerMediaRoutes } from './media.js'

export function registerRoutes(ctx, deps) {
  registerConfigRoutes(ctx, deps)
  registerMediaRoutes(ctx, deps)
  registerDiagnosticRoutes(ctx, deps)
  registerMaintenanceRoutes(ctx, deps)
}
export { registerConfigRoutes } from './config.js'
export { registerDiagnosticRoutes } from './diagnostics.js'
export { registerMaintenanceRoutes } from './maintenance.js'
export { registerMediaRoutes } from './media.js'
