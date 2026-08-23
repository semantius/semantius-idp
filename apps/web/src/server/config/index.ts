export { ConfigError, formatIssues, toPointer } from "./errors"
export type { ConfigFileName, ConfigIssue, ConfigWarning } from "./errors"
export { deriveConfig, isLocalhostUrl, parseBasePath } from "./derive"
export type { BasePathInfo, EffectiveResource, IdpConfig } from "./derive"
export { DEFAULT_CONFIG_DIR, loadConfig } from "./loader"
export type { LoadConfigOptions, LoadedConfig } from "./loader"
export { isSecretPointer, maskConfig, maskConnectionString } from "./mask"
export { substitutePlaceholders } from "./placeholders"
export { runCrossChecks } from "./cross-checks"
export { parseJsoncText, stripSchemaKey } from "./jsonc"
export {
  clientsFileSchema,
  clientSchema,
  CLIENT_TYPES,
  PUBLIC_CLIENT_TYPES,
  SUPPORTED_GRANT_TYPES,
} from "./schema/clients-schema"
export type {
  ClientEntry,
  ClientsFile,
  ClientType,
} from "./schema/clients-schema"
export {
  configFileSchema,
  RESERVED_CLAIM_NAMES,
  SUPPORTED_JWT_ALGORITHMS,
  USER_CLAIM_NAMES,
} from "./schema/config-schema"
export type {
  ConfigFile,
  SocialProviderConfig,
  UserClaimName,
} from "./schema/config-schema"
export {
  BUILT_IN_ROLES,
  rolesFileSchema,
  roleSchema,
} from "./schema/roles-schema"
export type { RoleEntry, RolesFile } from "./schema/roles-schema"
export { parseDurationSeconds } from "./zod-helpers"
