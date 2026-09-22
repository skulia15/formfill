/* Shared URL matching. Loaded as a classic script by both the content script
 * and the popup, so the two can never disagree about what a pattern means. */

// `*` matches any run of characters. Everything else is literal, so a pattern
// can safely contain regex metacharacters like `.` `?` `+` from a real URL.
function globToRegExp(glob) {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

function formFillMatches(profile, url) {
  if (profile.enabled === false) return false;
  const bare = url.split('#')[0];
  try {
    const u = new URL(url);
    if (profile.mode === 'exact') return bare === profile.pattern.split('#')[0];
    if (profile.mode === 'origin') return u.origin === profile.pattern;
    if (profile.mode === 'glob') return globToRegExp(profile.pattern).test(bare);
    return url.startsWith(profile.pattern);
  } catch {
    return false;
  }
}

/* A wildcard pattern is more specific the more literal text it pins down,
 * so rank by length with the wildcards removed. */
function formFillSpecificity(profile) {
  return profile.pattern.split('*').join('').length;
}
