/**
 * Shared notebook utilities — URL normalization and alias generation.
 */

/** Strip query params, hash fragments, and trailing slash for consistent URL comparison. */
export const normalizeUrl = (u: string): string =>
  u.split("?")[0].split("#")[0].replace(/\/$/, "");

/**
 * Generate a valid alias from a notebook title.
 * Strips non-alphanumeric chars, lowercases, and truncates to 50 chars.
 */
export function generateAlias(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "notebook"
  );
}
