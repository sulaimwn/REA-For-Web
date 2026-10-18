// REA 6.7's real tiny-android failure (fixtures/samples/tiny-android.rea-6.7.0.json).
// Recover only this exact bytecode-selection failure, never transport, integrity or timeout errors.
export interface AndroidMethodIdentity {
  name?: unknown;
  overload_index?: unknown;
  dex_descriptor?: unknown;
  is_constructor?: unknown;
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function isKnownAndroidBodyGap(raw: unknown, sha256: string, className: string, method: AndroidMethodIdentity): boolean {
  const record = object(raw);
  // An error must never simultaneously supply successful Evidence/body fields.
  if (!record || Object.keys(record).length !== 1 || !('error' in record)) return false;
  if (!/^[a-f0-9]{64}$/u.test(sha256) || method.name !== '<init>' || method.dex_descriptor !== '()V'
    || method.is_constructor !== true || method.overload_index !== 0) return false;
  const error = object(record.error);
  const details = object(error?.details);
  const diagnostics = object(details?.diagnostics);
  const observation = object(details?.partial_observation);
  const target = object(observation?.target);
  if (error?.code !== 'execution_failure' || error.category !== 'execution_failure' || error.retryable !== false
    || details?.provider_id !== 'jadx' || details.operation !== 'inspect_android_method'
    || diagnostics?.upstream_operation !== 'get_method_body'
    || diagnostics.reason !== 'Disassembly could not establish one selected method: <init>()V'
    || diagnostics.target_sha256 !== sha256 || target?.sha256 !== sha256 || target.format !== 'apk'
    || observation?.provider_id !== 'jadx' || observation.operation !== 'inspect_android_method') return false;
  const calls = observation.calls;
  if (!Array.isArray(calls)) return false;
  const bodies = calls.filter(c => object(c)?.operation === 'get_method_body');
  if (bodies.length !== 1) return false;
  const body = object(bodies[0]);
  const input = object(body?.input);
  const response = object(body?.response);
  const content = response?.content;
  return input?.class_name === className && input.method_name === method.name
    && input.overload_index === method.overload_index && input.smali_fallback === true
    && response?.isError === true && Array.isArray(content) && content.length === 1
    && object(content[0])?.type === 'text' && object(content[0])?.text === diagnostics.reason;
}
