/**
 * Web knowledge-base plugin, node half.
 *
 * Deliberately empty: the whole feature is browser-side (sidebar trigger,
 * browse/edit panel) plus the `kb` Remote namespace it calls for library
 * data and the `/dsh-kb` image route. Nothing here mounts host services;
 * `@deepseek-ai/dsh-host-kb` owns the engine, the Remote, and the route and
 * is composed as its own host row in the web-app bundle.
 */

/** Host plugin body — browser-only feature. */
export function apply(): void {}
