/**
 * Web word-lookup plugin, node half.
 *
 * Deliberately empty: the whole feature is browser-side (selection detection,
 * floating action bar, result card) plus the `lookupLlm` Remote namespace it
 * calls for model-generated explanations. Nothing here mounts host services;
 * `@deepseek-ai/dsh-host-lookup-llm` owns the model-backed explanation endpoint
 * and is composed as its own host row in the web-app bundle.
 */

/** Host plugin body — browser-only feature. */
export function apply(): void {}
