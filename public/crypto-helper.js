// Crypto Helper using Web Crypto API for End-to-End Encryption (E2EE)
// Works purely on the client side, using the room password as a shared secret.

const CryptoHelper = (() => {
  // Helper to convert array buffer to base64 string
  function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // Helper to convert base64 string to array buffer
  function base64ToBuffer(base64) {
    const binary = window.atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Derive an AES-GCM key from room password and room code (used as salt)
  async function deriveKey(password, roomCode) {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);
    
    // Use room code as the salt (must be at least 16 bytes, pad if necessary)
    let saltString = roomCode.padEnd(16, 'salt-padding-string');
    if (saltString.length > 32) {
      saltString = saltString.slice(0, 32);
    }
    const saltBuffer = encoder.encode(saltString);

    // Import password as raw key material
    const baseKey = await window.crypto.subtle.importKey(
      'raw',
      passwordBuffer,
      { name: 'PBKDF2' },
      false,
      ['deriveKey', 'deriveBits']
    );

    // Derive the final AES-GCM key
    return await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBuffer,
        iterations: 100000,
        hash: 'SHA-256'
      },
      baseKey,
      {
        name: 'AES-GCM',
        length: 256
      },
      false, // non-extractable for security
      ['encrypt', 'decrypt']
    );
  }

  // Encrypt a string message using AES-GCM
  async function encryptText(text, key) {
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(text);
    
    // Generate a secure random 12-byte IV
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    
    const ciphertext = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      key,
      encodedData
    );

    return {
      ciphertext: bufferToBase64(ciphertext),
      iv: bufferToBase64(iv)
    };
  }

  // Decrypt a string message using AES-GCM
  async function decryptText(encryptedObj, key) {
    try {
      const ciphertext = base64ToBuffer(encryptedObj.ciphertext);
      const iv = new Uint8Array(base64ToBuffer(encryptedObj.iv));

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv
        },
        key,
        ciphertext
      );

      const decoder = new TextDecoder();
      return decoder.decode(decryptedBuffer);
    } catch (e) {
      console.error('Decryption failed. Incorrect key or corrupt data.', e);
      throw new Error('Decryption failed');
    }
  }

  // Encrypt a binary file buffer using AES-GCM
  async function encryptBuffer(arrayBuffer, key) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      key,
      arrayBuffer
    );
    return {
      encryptedBuffer: encrypted,
      iv: iv // returns Uint8Array IV directly for binary packaging
    };
  }

  // Decrypt a binary file buffer using AES-GCM
  async function decryptBuffer(encryptedBuffer, iv, key) {
    try {
      return await window.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv
        },
        key,
        encryptedBuffer
      );
    } catch (e) {
      console.error('File decryption failed. Incorrect key or corrupt data.', e);
      throw new Error('File decryption failed');
    }
  }

  return {
    deriveKey,
    encryptText,
    decryptText,
    encryptBuffer,
    decryptBuffer
  };
})();

// Export if in Node context (not needed here since loaded in index.html, but good practice)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CryptoHelper;
}
