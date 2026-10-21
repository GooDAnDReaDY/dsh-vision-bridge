// dsh-vision-bridge — pure core facade (#206, #438).
//
// Hand-written core decomposed into domain-specific modules:
// - lib/vision-config.js: Config schema and model/image block acceptance predicates
// - lib/security.js: Access guards, CSRF/SSRF prevention, path containment, masking, bounded body
// - lib/providers.js: Provider definitions and API key resolution
// - lib/media-utils.js: Pure image math, perceptual hashing, transforms, session attachments
//
// Backwards compatibility facade: re-exports all 4 domains transparently.

export * from './vision-config.js'
export * from './security.js'
export * from './providers.js'
export * from './media-utils.js'
