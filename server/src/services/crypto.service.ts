import crypto from 'crypto';
import { promisify } from 'util';
import { config } from '../config';

const pbkdf2 = promisify(crypto.pbkdf2);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

function deriveKey(salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(config.encryptionSecret, salt, ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Encrypt a Nostr private key (hex string) using AES-256-GCM.
 * Returns a base64 string containing: salt + iv + tag + ciphertext
 */
export function encryptPrivateKey(privateKeyHex: string): string {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(salt);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(privateKeyHex, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Combine: salt(64) + iv(16) + tag(16) + ciphertext
    const combined = Buffer.concat([salt, iv, tag, encrypted]);
    return combined.toString('base64');
}

function splitEncrypted(encryptedBase64: string) {
    const combined = Buffer.from(encryptedBase64, 'base64');
    return {
        salt: combined.subarray(0, SALT_LENGTH),
        iv: combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH),
        tag: combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH),
        ciphertext: combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH),
    };
}

function decryptWithKey(parts: ReturnType<typeof splitEncrypted>, key: Buffer): string {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, parts.iv);
    decipher.setAuthTag(parts.tag);

    const decrypted = Buffer.concat([
        decipher.update(parts.ciphertext),
        decipher.final(),
    ]);

    return decrypted.toString('utf8');
}

/**
 * Decrypt a Nostr private key from its encrypted base64 form.
 * Returns the hex private key string.
 */
export function decryptPrivateKey(encryptedBase64: string): string {
    const parts = splitEncrypted(encryptedBase64);
    return decryptWithKey(parts, deriveKey(parts.salt));
}

/**
 * The same, with the key derivation (100,000 rounds of PBKDF2, tens of
 * milliseconds) on libuv's thread pool instead of the event loop. Use this
 * on request paths: the hosted signer runs it for every signature.
 */
export async function decryptPrivateKeyAsync(encryptedBase64: string): Promise<string> {
    const parts = splitEncrypted(encryptedBase64);
    const key = await pbkdf2(config.encryptionSecret, parts.salt, ITERATIONS, KEY_LENGTH, 'sha512');
    return decryptWithKey(parts, key);
}
