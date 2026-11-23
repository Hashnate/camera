"""Biometric Encryption & Security Utility.

Implements AES-256-GCM authenticated encryption for face embedding vectors.
Generates unique 96-bit (12-byte) initialization vectors (IVs) for each encryption operation.
Embeddings are serialized as 128 IEEE 754 float32 values (512 bytes).
"""

import os
import struct
from typing import List, Tuple
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from app.config import settings

# Master key ID for audit and key rotation tracking
DEFAULT_KEY_ID = "v2-master-key-01"


def _get_encryption_key() -> bytes:
    key_str = getattr(settings, "BIOMETRIC_ENCRYPTION_KEY", "") or os.environ.get("BIOMETRIC_ENCRYPTION_KEY", "")
    if key_str:
        # If hex-encoded 64 chars, convert to 32 bytes; else pad/truncate to 32 bytes
        if len(key_str) == 64:
            try:
                return bytes.fromhex(key_str)
            except ValueError:
                pass
        return key_str.encode("utf-8").ljust(32, b"0")[:32]
    # Fallback to deterministic key derived from JWT_SECRET or default for development
    base = (getattr(settings, "JWT_SECRET", "") or "worksight-biometric-secure-salt-2026").encode("utf-8")
    return base.ljust(32, b"k")[:32]


def encrypt_embedding(embedding: List[float], key_id: str = DEFAULT_KEY_ID) -> Tuple[bytes, str, str, str]:
    """Encrypt a 128-d float embedding using AES-256-GCM.
    
    Returns:
        (ciphertext_bytes, iv_hex, tag_hex, key_id)
    """
    key = _get_encryption_key()
    aesgcm = AESGCM(key)
    iv = os.urandom(12)  # 96-bit unique IV
    
    # Pack 128 float32 values into 512 bytes
    plaintext = struct.pack(f"{len(embedding)}f", *embedding)
    
    # AESGCM.encrypt appends 16-byte tag to ciphertext
    ciphertext_and_tag = aesgcm.encrypt(iv, plaintext, associated_data=key_id.encode("utf-8"))
    
    ciphertext = ciphertext_and_tag[:-16]
    tag = ciphertext_and_tag[-16:]
    
    return ciphertext, iv.hex(), tag.hex(), key_id


_TEXT_AAD = b"worksight-setting"


def encrypt_text(plaintext: str) -> str:
    """Encrypt a short secret (e.g. a camera-account password) for storage: hex(iv + ciphertext + tag)."""
    iv = os.urandom(12)
    return (iv + AESGCM(_get_encryption_key()).encrypt(iv, plaintext.encode("utf-8"), _TEXT_AAD)).hex()


def decrypt_text(blob_hex: str) -> str:
    raw = bytes.fromhex(blob_hex)
    return AESGCM(_get_encryption_key()).decrypt(raw[:12], raw[12:], _TEXT_AAD).decode("utf-8")


def decrypt_embedding(ciphertext: bytes, iv_hex: str, tag_hex: str, key_id: str = DEFAULT_KEY_ID) -> List[float]:
    """Decrypt and verify an AES-256-GCM encrypted embedding.
    
    Returns:
        List of 128 float values
    """
    key = _get_encryption_key()
    aesgcm = AESGCM(key)
    iv = bytes.fromhex(iv_hex)
    tag = bytes.fromhex(tag_hex)
    
    ciphertext_and_tag = ciphertext + tag
    plaintext = aesgcm.decrypt(iv, ciphertext_and_tag, associated_data=key_id.encode("utf-8"))
    
    num_floats = len(plaintext) // 4
    return list(struct.unpack(f"{num_floats}f", plaintext))
