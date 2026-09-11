# idp-setup-env.ps1 — the Windows half of idp-setup-env.sh; idp-setup-env.cmd
# is the entry point. Keep the two in step: this generates the same five
# secrets, with the same URL-safety rules, splices the database password into
# DATABASE_URL the same way, and is likewise a no-op when .env already exists.
#
# See idp-setup-env.sh for the reasoning (why generation happens at .env
# creation, why the two database passwords are hex rather than base64, and why
# the client secrets are base64url).
$ErrorActionPreference = 'Stop'

# This file lives in docker/; .env and .env.example live one level up.
$root    = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
$example = Join-Path $root '.env.example'

if (Test-Path -LiteralPath $envPath) {
  Write-Host '.env already exists - leaving it untouched.'
  exit 0
}
if (-not (Test-Path -LiteralPath $example)) {
  Write-Error 'idp-setup-env: .env.example is missing.'
  exit 1
}

function New-RandomBytes([int]$count) {
  $bytes = New-Object byte[] $count
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return $bytes
}

# Hex for the two database passwords (one of them is spliced into a URL),
# base64 for IDP_SECRET, which never is, and base64url for the client secrets
# -- the same split as idp-setup-env.sh. 48 bytes is 64 characters of base64
# with no padding, so the url variant has nothing to strip.
function New-UrlSafePassword { (New-RandomBytes 24 | ForEach-Object { $_.ToString('x2') }) -join '' }
function New-Secret          { [Convert]::ToBase64String((New-RandomBytes 48)) }
function New-ClientSecret    { (New-Secret).Replace('+', '-').Replace('/', '_') }

# `[^\r\n]*` rather than `.*`: in .NET `.` matches a lone \r, so `.*$` under
# (?m) would eat the CR of a CRLF file and leave that one line LF-terminated in
# an otherwise CRLF .env. .gitattributes checks .env.example out LF, but a
# copy an editor has saved as CRLF is still a CRLF file -- the substitution
# has to preserve whatever it finds.
function Set-EnvValue([string]$text, [string]$key, [string]$value) {
  $re = [regex]::new('(?m)^' + [regex]::Escape($key) + '=[^\r\n]*')
  if (-not $re.IsMatch($text)) {
    throw "idp-setup-env: .env.example has no uncommented $key= line - nothing was generated for it."
  }
  # A MatchEvaluator, so `$` in a generated value can never be read as a
  # substitution pattern ($1, $&, ...) in the replacement string.
  return $re.Replace($text, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) "$key=$value" }, 1)
}

# Only the password between `idp:` and `@postgres:5432/idp` changes; whatever
# host, port or query string the example carries stays exactly as shipped.
# Fails when the line is not there in that shape, for the same reason the key
# check above does: a URL that was not spliced would boot against the example
# password while POSTGRES/IDP_DB_PASSWORD say otherwise.
function Set-DatabaseUrlPassword([string]$text, [string]$value) {
  $re = [regex]::new('(?m)^(DATABASE_URL=postgres://idp:)[^@\r\n]*(@postgres:5432/idp)')
  if (-not $re.IsMatch($text)) {
    throw 'idp-setup-env: .env.example has no DATABASE_URL=postgres://idp:...@postgres:5432/idp line - the database password was not spliced into it.'
  }
  return $re.Replace($text, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $m.Groups[1].Value + $value + $m.Groups[2].Value }, 1)
}

$dbPassword = New-UrlSafePassword

$text = [IO.File]::ReadAllText($example)
$text = Set-EnvValue $text 'IDP_SECRET'                       (New-Secret)
$text = Set-EnvValue $text 'POSTGRES_PASSWORD'                (New-UrlSafePassword)
$text = Set-EnvValue $text 'IDP_DB_PASSWORD'                  $dbPassword
$text = Set-DatabaseUrlPassword $text                         $dbPassword
$text = Set-EnvValue $text 'EXAMPLE_WEB_CLIENT_SECRET'        (New-ClientSecret)
$text = Set-EnvValue $text 'EXAMPLE_FIRSTPARTY_CLIENT_SECRET' (New-ClientSecret)

# Temp file then move, so an interrupted run cannot leave a half-substituted
# .env behind -- one that would boot with an example value still in it. UTF8
# with NO BOM: a BOM would end up inside the first variable name compose
# parses.
$tmp = Join-Path $root ('.env.tmp.' + [IO.Path]::GetRandomFileName())
[IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $tmp -Destination $envPath -Force

Write-Host 'Created .env from .env.example, with freshly generated values for'
Write-Host '  IDP_SECRET, POSTGRES_PASSWORD, IDP_DB_PASSWORD (also inside DATABASE_URL),'
Write-Host '  EXAMPLE_WEB_CLIENT_SECRET and EXAMPLE_FIRSTPARTY_CLIENT_SECRET.'
Write-Host 'They are in .env (gitignored) - that is the only copy. Read the superuser password with:'
Write-Host '  findstr /b "POSTGRES_PASSWORD=" ..\.env'
