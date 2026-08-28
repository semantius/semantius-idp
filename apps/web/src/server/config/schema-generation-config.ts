/**
 * A fixed, minimal configuration used only to build the auth *options* for
 * schema generation (DM-1).
 *
 * The generated schema must depend on the plugin list and nothing else — if it
 * varied with an operator's `config.jsonc`, two deployments would need different
 * migrations and the CI drift gate would be meaningless. So the generator runs
 * against these constants, and every value here is deliberately one that cannot
 * influence a column: enabling e-mail or a social provider changes behaviour,
 * never the shape of a table.
 */

import { deriveConfig } from "./derive"
import type { IdpConfig } from "./derive"
import { configFileSchema } from "./schema/config-schema"
import { BUILT_IN_ROLES } from "./schema/roles-schema"

export function schemaGenerationConfig(): IdpConfig {
  const file = configFileSchema.parse({
    server: { baseUrl: "http://localhost:3000" },
    secret: "schema-generation-placeholder-secret-0000",
    database: { url: "postgres://schema:generation@localhost:5432/idp" },
    site: { name: "semantius-idp" },
    jwt: { audience: "http://localhost:3000" },
  })
  return deriveConfig(file, [], BUILT_IN_ROLES)
}
