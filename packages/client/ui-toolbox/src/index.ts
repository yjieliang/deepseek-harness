/**
 * Web developer toolbox plugin, node half.
 *
 * Deliberately empty: the whole feature is browser-side (sidebar trigger,
 * overlay panel) plus the `toolbox` Remote namespace it calls for translation
 * and UUID generation. `@deepseek-ai/dsh-host-toolbox` owns the engine and the
 * Remote and is composed as its own host row in the web-app bundle.
 */

/** Host plugin body — browser-only feature. */
export function apply(): void {}
