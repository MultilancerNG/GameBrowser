/** Shared restored-workspace sensitive-target policy; Node and Bun use the same patterns. */
export const sensitiveTargetPattern = /(?:^|[^a-z0-9])(?:pass(?:word|code)?|pwd|secret|token|api[\s_-]*key|auth(?:entication|orize|orisation|orization)?|log[\s_-]*in|sign[\s_-]*in|sign[\s_-]*up|register|credential|username|user[\s_-]*name|email|phone|pin|code|otp|2fa|mfa|two[\s_-]*factor|verification|verify|captcha|turnstile|hcaptcha|recaptcha|challenge|deposit|withdraw(?:al)?|payout|payment|pay|purchase|buy|sell|checkout|wallet|bank|card|amount|stake|wager|bet(?:s|ting)?|place[\s_-]*bet|cash[\s_-]*out|trade|transfer|send[\s_-]*money|tip)(?:$|[^a-z0-9])/i;
export const sensitivePathPattern = /(?:^|\/)(?:login|sign[-_]?in|sign[-_]?up|register|auth|oauth|verify|verification|2fa|mfa|captcha|challenge|deposit|withdraw(?:al)?|payout|payment|checkout|wallet|cashier)(?:\/|$)/i;

/** Runs in the browser realm; inspects only element metadata, never field values. */
export function sensitiveControl(element, patternSource) {
  if (!(element instanceof Element)) return true;
  element = element.closest('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="tab"],[contenteditable="true"]') ?? element;
  const pattern = new RegExp(patternSource ?? "(?!)", "i");
  const document = element.ownerDocument;
  const sensitiveText = (value) => pattern.test(String(value ?? "").replace(/([a-z])([A-Z])/g, "$1 $2"));
  if (document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="hcaptcha.com"],iframe[src*="recaptcha"],.cf-turnstile,.h-captcha,.g-recaptcha,[data-sitekey],input[autocomplete="one-time-code"],input[type="password"]')) return true;
  if (patternSource === null) return false;
  if (element.matches('select,[contenteditable="true"],input[type="password"],input[type="email"],input[type="tel"],input[type="number"],input[type="file"],input[type="hidden"],input[type="submit"],input[type="image"],button[type="submit"],button[type="reset"]')) return true;
  if (element instanceof HTMLInputElement && !["text", "search", "checkbox", "radio"].includes(element.type)) return true;
  if (element instanceof HTMLInputElement && element.maxLength > 0 && element.maxLength <= 8 && element.inputMode === "numeric") return true;
  const attributes = ["name", "id", "data-testid", "data-test", "aria-label", "title", "autocomplete", "placeholder"];
  if (attributes.some((name) => sensitiveText(element.getAttribute(name)))) return true;
  if (!["input", "textarea", "select"].includes(element.localName) && sensitiveText(element.textContent?.slice(0, 160))) return true;
  if (element.hasAttribute("href")) { try { if (sensitiveText(new URL(element.getAttribute("href"), document.location.href).pathname)) return true; } catch { return true; } }
  if (element.labels && [...element.labels].some((label) => sensitiveText(label.textContent))) return true;
  const form = element.closest("form");
  if (form && (["action", "id", "name", "aria-label", "data-testid"].some((name) => sensitiveText(form.getAttribute(name)))
    || form.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]'))) return true;
  let parent = element.parentElement;
  for (let depth = 0; parent && depth < 2 && !["body", "html", "main"].includes(parent.localName); depth++, parent = parent.parentElement) {
    if (["id", "name", "aria-label", "data-testid", "data-test"].some((name) => sensitiveText(parent.getAttribute(name)))) return true;
  }
  return false;
}
