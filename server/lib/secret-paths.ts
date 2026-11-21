import { basename, relative } from "node:path"
import { isInside } from "./files.ts"

// The one deny list for showing files that a document links to (/api/open, /api/file).
// Keep it small: it guards against a click that would put a secret on screen.

/** Folders under HOME that hold keys and tokens. */
const SECRET_HOME_DIRS = [".ssh", ".gnupg", ".aws", ".password-store", ".config/gh"]
/** File names that look like keys, tokens or passwords, anywhere. */
const SECRET_NAMES = [
  /^\.env/i, // .env, .env.local, .envrc
  /\.(pem|key|p12|pfx)$/i,
  /credentials/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(netrc|pgpass)$/i,
]
/** Under ~/.config, also files named like passwords (e.g. ~/.config/wiki/admin-password). */
const SECRET_CONFIG_NAMES = /password|passwd|secret|token/i

export const SECRET_REFUSAL = "Not shown: looks like a secret file"

/** True when an absolute path looks like a secret file. Check both the asked and the real path. */
export function looksSecret(path: string, home: string): boolean {
  const name = basename(path)
  if (SECRET_NAMES.some((pattern) => pattern.test(name))) return true
  if (!isInside(home, path)) return false
  const rel = relative(home, path)
  if (SECRET_HOME_DIRS.some((dir) => rel === dir || rel.startsWith(dir + "/"))) return true
  return rel.startsWith(".config/") && SECRET_CONFIG_NAMES.test(name)
}
