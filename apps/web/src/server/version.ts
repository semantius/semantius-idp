/**
 * The running version, reported by `/healthz`, `idp version` and the admin
 * system page.
 *
 * Injected at build time by the image build; falls back to the workspace
 * version so a development run has something meaningful to show.
 */
export const version: string = process.env.IDP_VERSION ?? "0.6.7-dev"

/** Immutable image tag (`sha-<git>`), when the build supplied one. */
export const revision: string | undefined = process.env.IDP_REVISION
