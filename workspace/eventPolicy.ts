import { sensitiveTargetPattern, sensitivePathPattern } from "../agent/browser-sync-policy.mjs";
export { sensitiveTargetPattern, sensitivePathPattern };
/** Fail-closed policy shared by the relay and browser bridge. No credential or
 * financial interaction is eligible for automatic synchronization. */
export const ACTION_TYPES = ['click', 'input', 'scroll'] as const;
export type ActionKind = typeof ACTION_TYPES[number];
export type TargetFingerprint = {
  tag: string;
  type?: string;
  role?: string;
  name?: string;
  text?: string;
  placeholder?: string;
  href?: string;
};
export type ActionPacket = {
  type: 'ACTION';
  id: string;
  seq: number;
  epoch: number;
  origin: string;
  url: string;
  action: ActionKind;
  selector?: string;
  value?: string;
  x?: number;
  y?: number;
  fingerprint?: TargetFingerprint;
};
export type ActionValidation = { ok: true; action: ActionPacket } | { ok: false; reason: string };
export type ActionContext = { origins?: readonly string[]; epoch?: number; maxValueLength?: number };
export const actionPolicy = Object.freeze({
  maxPacketBytes: 8192,
  maxSelectorLength: 512,
  maxValueLength: 512,
  maxUrlLength: 2048,
  allowedActions: ACTION_TYPES,
  mirrorsCredentials: false,
  mirrorsFinancialActions: false,
  replaysBacklog: false,
});

// Deliberately includes related verbs and fields: a betting amount input is as
// sensitive as the button that submits it. Separators also match DOM attributes.
const forbiddenInputTypes = new Set(['password', 'email', 'tel', 'number', 'file', 'hidden', 'submit', 'button', 'image']);
const actionKeys = new Set(['type', 'id', 'seq', 'epoch', 'origin', 'url', 'action', 'selector', 'value', 'x', 'y', 'fingerprint']);
const fingerprintKeys = new Set(['tag', 'type', 'role', 'name', 'text', 'placeholder', 'href']);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const reject = (reason: string): ActionValidation => ({ ok: false, reason });
const boundedString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);

export function isSensitiveTarget(fingerprint: TargetFingerprint | Record<string, unknown>): boolean {
  const tag = typeof fingerprint.tag === 'string' ? fingerprint.tag.toLowerCase() : '';
  const type = typeof fingerprint.type === 'string' ? fingerprint.type.toLowerCase() : '';
  if ((tag === 'input' && forbiddenInputTypes.has(type)) || (tag === 'button' && ['submit', 'reset'].includes(type))) return true;
  return ['type', 'role', 'name', 'text', 'placeholder', 'href'].some((key) => {
    const value = fingerprint[key as keyof TargetFingerprint];
    // Camel case attributes, e.g. placeBet and currentPassword, must match too.
    return typeof value === 'string' && sensitiveTargetPattern.test(value.replace(/([a-z])([A-Z])/g, '$1 $2'));
  });
}

export function validateAllowedOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin !== value) return null;
    return url.origin;
  } catch { return null; }
}

export function validateActionPacket(value: unknown, context: ActionContext = {}): ActionValidation {
  if (!record(value)) return reject('Action must be an object');
  if (Object.keys(value).some((key) => !actionKeys.has(key))) return reject('Unknown action field');
  let size: number;
  try { size = new TextEncoder().encode(JSON.stringify(value)).length; } catch { return reject('Invalid action serialization'); }
  if (size > actionPolicy.maxPacketBytes) return reject('Action exceeds packet limit');
  if (value.type !== 'ACTION' || !ACTION_TYPES.includes(value.action as ActionKind)) return reject('Unsupported action');
  if (!boundedString(value.id, 80) || !/^[a-zA-Z0-9_-]{8,80}$/.test(value.id)) return reject('Invalid action identifier');
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1 || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0) return reject('Invalid action sequence or epoch');
  if (context.epoch !== undefined && value.epoch !== context.epoch) return reject('Stale action epoch');
  const origin = validateAllowedOrigin(value.origin);
  if (!origin || (context.origins && !context.origins.includes(origin))) return reject('Origin is not approved');
  if (!boundedString(value.url, actionPolicy.maxUrlLength)) return reject('Invalid page URL');
  try {
    const page = new URL(value.url);
    if (page.origin !== origin || page.username || page.password || page.hash || page.search || sensitivePathPattern.test(page.pathname)) return reject('Sensitive or mismatched page URL');
  } catch { return reject('Invalid page URL'); }
  if (value.action === 'scroll') {
    if (value.selector !== undefined || value.fingerprint !== undefined || value.value !== undefined) return reject('Unexpected scroll fields');
    if (![value.x, value.y].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000)) return reject('Invalid scroll position');
  } else {
    if (value.x !== undefined || value.y !== undefined) return reject('Unexpected action coordinates');
    if (!boundedString(value.selector, actionPolicy.maxSelectorLength) || !value.selector.trim()) return reject('Missing selector');
    // Exclude CSS classes, pseudo expressions other than bounded structural
    // nth-of-type, HTML/control bytes, and sensitive selector attributes.
    const withoutQuotedStrings = value.selector.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (/[.<`{};]/.test(withoutQuotedStrings) || /:(?!nth-of-type\([1-9]\d{0,2}\))/i.test(withoutQuotedStrings) || sensitiveTargetPattern.test(value.selector.replace(/([a-z])([A-Z])/g, '$1 $2'))) return reject('Unsafe selector');
    if (!record(value.fingerprint) || Object.keys(value.fingerprint).some((key) => !fingerprintKeys.has(key))) return reject('Missing target verification');
    if (!boundedString(value.fingerprint.tag, 24) || !/^[a-z][a-z0-9-]*$/.test(value.fingerprint.tag)) return reject('Invalid target tag');
    for (const [key, field] of Object.entries(value.fingerprint)) {
      if (!boundedString(field, key === 'href' ? 512 : 160)) return reject('Invalid target verification');
    }
    if (isSensitiveTarget(value.fingerprint)) return reject('Sensitive interaction requires manual control');
    if (value.action === 'input') {
      if (!['input', 'textarea'].includes(value.fingerprint.tag)) return reject('Input target is not editable');
      if (!boundedString(value.value, Math.min(context.maxValueLength ?? actionPolicy.maxValueLength, actionPolicy.maxValueLength))) return reject('Input exceeds limit');
    } else if (value.value !== undefined) return reject('Unexpected click value');
  }
  return { ok: true, action: value as ActionPacket };
}
