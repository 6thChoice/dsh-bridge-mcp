// `tsc` writes 0644 files, but npm's Unix bin shim symlinks straight to the
// entry file. Mark our bins executable so `npm link` yields working commands.
import { chmodSync, existsSync } from 'node:fs';

for (const file of ['dist/cli.js', 'dist/mcp.js']) {
  if (existsSync(file)) chmodSync(file, 0o755);
}
