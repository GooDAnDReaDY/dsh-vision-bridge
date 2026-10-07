// #291, #412: HTTP route registrations wiring
import { registerRoutes } from './routes/index.js'

export function setupPluginRoutes(ctx, deps) {
  registerRoutes(ctx, deps)
}
