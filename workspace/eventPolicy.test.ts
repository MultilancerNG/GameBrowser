import { describe, expect, test } from 'bun:test';
import { isSensitiveTarget, validateActionPacket, validateAllowedOrigin } from './eventPolicy';

const base = () => ({ type: 'ACTION', id: 'action_test_123', seq: 1, epoch: 3, origin: 'https://stake.com', url: 'https://stake.com/casino/games/limbo', action: 'click', selector: '[data-testid="game-rules"]', fingerprint: { tag: 'button', text: 'Game rules' } });
describe('synchronizer event policy', () => {
  test('accepts verified nonfinancial click only on exact approved origin and epoch', () => {
    expect(validateActionPacket(base(), { origins: ['https://stake.com'], epoch: 3 }).ok).toBe(true);
    expect(validateActionPacket(base(), { origins: ['https://bc.game'] }).ok).toBe(false);
    expect(validateActionPacket(base(), { epoch: 4 }).ok).toBe(false);
  });
  test('accepts actual safe button type while preserving input, submit, reset and financial guards', () => {
    const actualButton = { ...base(), selector: 'button[data-testid="open-panel"]', fingerprint: { tag: 'button', type: 'button', name: 'open-panel', text: 'Open panel' } };
    expect(isSensitiveTarget(actualButton.fingerprint)).toBe(false);
    expect(validateActionPacket(actualButton, { origins: ['https://stake.com'], epoch: 3 }).ok).toBe(true);
    expect(validateActionPacket({ ...actualButton, fingerprint: { ...actualButton.fingerprint, text: 'Place bet' } }).ok).toBe(false);
    expect(validateActionPacket({ ...actualButton, fingerprint: { ...actualButton.fingerprint, text: 'Log in' } }).ok).toBe(false);
    for (const type of ['submit', 'reset']) expect(validateActionPacket({ ...actualButton, fingerprint: { ...actualButton.fingerprint, type } }).ok).toBe(false);
    expect(validateActionPacket({ ...actualButton, fingerprint: { ...actualButton.fingerprint, tag: 'input' } }).ok).toBe(false);
  });
  test('rejects malformed, unknown and overlarge packets', () => {
    expect(validateActionPacket(null).ok).toBe(false);
    expect(validateActionPacket({ ...base(), token: 'never transmitted' }).ok).toBe(false);
    expect(validateActionPacket({ ...base(), seq: 1.5 }).ok).toBe(false);
    expect(validateActionPacket({ ...base(), selector: 'x'.repeat(513) }).ok).toBe(false);
    expect(validateActionPacket({ ...base(), fingerprint: { tag: 'button', text: 'a'.repeat(9000) } }).ok).toBe(false);
  });
  test('blocks financial actions, credentials and challenge fields including camel case', () => {
    for (const word of ['Place bet', 'Cash out', 'Deposit', 'Withdraw', 'Login', 'OTP', 'hCaptcha', 'Payment', 'Wallet', 'placeBet', 'currentPassword', 'betAmount', 'verificationCode']) {
      expect(isSensitiveTarget({ tag: 'button', text: word })).toBe(true);
      expect(validateActionPacket({ ...base(), fingerprint: { tag: 'button', text: word } }).ok).toBe(false);
    }
    expect(validateActionPacket({ ...base(), selector: '[name="betAmount"]' }).ok).toBe(false);
    expect(validateActionPacket({ ...base(), action: 'input', value: '123456', selector: '[name="code"]', fingerprint: { tag: 'input', type: 'password' } }).ok).toBe(false);
  });
  test('permits bounded search text and structural selectors, never arbitrary pseudo queries', () => {
    const search = { ...base(), action: 'input', selector: 'main > form:nth-of-type(2) > input[name="search"]', value: 'table games', fingerprint: { tag: 'input', type: 'search', name: 'search' } };
    expect(validateActionPacket(search).ok).toBe(true);
    expect(validateActionPacket({ ...search, value: 'x'.repeat(513) }).ok).toBe(false);
    expect(validateActionPacket({ ...search, selector: 'button:has(*)' }).ok).toBe(false);
    expect(validateActionPacket({ ...search, selector: '.hashed_framework_button' }).ok).toBe(false);
    expect(validateActionPacket({ ...search, fingerprint: { tag: 'input', type: 'number' } }).ok).toBe(false);
  });
  test('strict URL policy does not transmit credentials or query parameters', () => {
    for (const url of ['https://stake.com/login', 'https://stake.com/auth/verify', 'https://stake.com/wallet', 'https://stake.com/?token=secret', 'https://stake.com/#code', 'https://stake.com.evil.example/casino', 'http://stake.com/casino']) {
      expect(validateActionPacket({ ...base(), url }).ok).toBe(false);
    }
    expect(validateAllowedOrigin('https://stake.com')).toBe('https://stake.com');
    expect(validateAllowedOrigin('http://127.0.0.1:8089')).toBe('http://127.0.0.1:8089');
    for (const origin of ['https://stake.com/', 'http://stake.com', 'https://user:secret@stake.com', 'https://stake.com?x=1']) expect(validateAllowedOrigin(origin)).toBeNull();
  });
  test('scroll accepts bounded coordinates without selector, values or verification data', () => {
    const scroll = { type: 'ACTION', id: 'scroll_test_123', seq: 2, epoch: 3, origin: 'https://stake.com', url: 'https://stake.com/casino/games/limbo', action: 'scroll', x: 0, y: 650 };
    expect(validateActionPacket(scroll).ok).toBe(true);
    expect(validateActionPacket({ ...scroll, y: -1 }).ok).toBe(false);
    expect(validateActionPacket({ ...scroll, y: Infinity }).ok).toBe(false);
    expect(validateActionPacket({ ...scroll, value: 'secret' }).ok).toBe(false);
  });
});
