import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encryptionService } from '../src/services/encryptionService';
// The frontend's own implementation (Web Crypto, available as a Node global)
import {
  encryptWithPassword as browserEncrypt,
  decryptWithPassword as browserDecrypt,
} from '../../lib/utils/crypto';

const SSH_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('credential encryption', () => {
  test('backend decrypts what the browser encrypted', async () => {
    const blob = await browserEncrypt(SSH_KEY, 'account password 1');

    assert.equal(encryptionService.decryptWithPassword(blob, 'account password 1'), SSH_KEY);
  });

  test('browser decrypts what the backend re-encrypted', async () => {
    const blob = encryptionService.encryptWithPassword(SSH_KEY, 'new account password');

    assert.equal(await browserDecrypt(blob, 'new account password'), SSH_KEY);
  });

  test('the wrong password does not decrypt', () => {
    const blob = encryptionService.encryptWithPassword('s3cret', 'right password');

    assert.throws(() => encryptionService.decryptWithPassword(blob, 'wrong password'));
  });

  test('recognises password-encrypted credentials, and plaintext ones as not', async () => {
    assert.equal(encryptionService.isClientEncrypted(await browserEncrypt('pw', 'account password')), true);
    assert.equal(encryptionService.isClientEncrypted(encryptionService.encryptWithPassword('pw', 'x')), true);

    assert.equal(encryptionService.isClientEncrypted(SSH_KEY), false);
    assert.equal(encryptionService.isClientEncrypted('hunter2'), false);
    // Valid base64, but far too short to hold salt + IV + auth tag
    assert.equal(encryptionService.isClientEncrypted('aGVsbG8gd29ybGQ='), false);
  });

  test('server-side layer round-trips the client-encrypted blob', async () => {
    const blob = await browserEncrypt(SSH_KEY, 'account password');
    const stored = encryptionService.encrypt(blob);

    assert.equal(encryptionService.decryptCredential(stored, 'account password'), SSH_KEY);
  });
});
