/** Runtime floor check; the CLI and the MCP shell both need it. */

export const MINIMUM_NODE = '22.19.0';

export function isNodeVersionSupported(version: string = process.versions.node): boolean {
  const [majorRaw, minorRaw] = version.split('.');
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return major > 22 || (major === 22 && minor >= 19);
}

export function nodeVersionMessage(version: string = process.versions.node): string {
  return `dsh-bridge needs Node >=${MINIMUM_NODE} (global fetch + WebSocket); running ${version}`;
}
