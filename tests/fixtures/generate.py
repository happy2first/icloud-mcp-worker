"""Build-time only: synthetic vectors against pinned Python source, never live credentials."""
import ast
import base64
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import zlib

ROOT = Path(__file__).resolve().parents[2]
if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 tests/fixtures/generate.py <pinned-pyicloud-checkout>')
UPSTREAM = Path(sys.argv[1])
PIN = 'e2e44ab875d47dab4475096021da60030f26c35e'
import subprocess
assert subprocess.check_output(['git', '-C', str(UPSTREAM), 'rev-parse', 'HEAD'], text=True).strip() == PIN

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

kdf = load('reference_kdf', UPSTREAM / 'pyicloud/srp_password.py')
prover = load('reference_prover', UPSTREAM / 'pyicloud/hsa2_bridge_prover.py')
from srp import _pysrp as srp
srp.rfc5054_enable()
srp.no_username_in_x()
vectors = []
for protocol in ['s2k', 's2k_fo']:
    for i, password in enumerate(['synthetic-only-password', '合成 🧑‍💻 café', '', '\u0000leading-zero']):
        salt = bytes.fromhex('000102030405060708090a0b0c0d0e0f')
        iterations = 1000 + i
        p = kdf.SrpPassword(password)
        p.set_encrypt_info(salt, iterations, 32, kdf.SrpProtocolType(protocol))
        derived = p.encode()
        ephemeral = (1 if i == 0 else 17 + i).to_bytes(256, 'big')
        account = 'synthetic@example.invalid'
        user = srp.User(account, p, hash_alg=srp.SHA256, ng_type=srp.NG_2048, bytes_a=ephemeral)
        _, a = user.start_authentication()
        n, g = srp.get_ng(srp.NG_2048, None, None)
        verifier = srp.Verifier(account, salt, srp.long_to_bytes(pow(g, srp.gen_x(hashlib.sha256, salt, account, p), n)), a, hash_alg=srp.SHA256, ng_type=srp.NG_2048, bytes_b=(41 + i).to_bytes(256, 'big'))
        _, b = verifier.get_challenge()
        m1 = user.process_challenge(salt, b)
        m2 = verifier.verify_session(m1)
        assert m2 == user.H_AMK
        vectors.append(dict(protocol=protocol, password=password, salt=salt.hex(), iterations=iterations, derived=derived.hex(), ephemeral=ephemeral.hex(), account=account, A=a.hex(), B=b.hex(), M1=m1.hex(), M2=m2.hex()))

salt = b'0123456789abcdef'
w0, w1 = prover._compute_w0_w1('050044', base64.b64encode(salt).decode())
client = prover._ClientHandshake(x_scalar=7, w0=w0, w1=w1)
server = prover._ServerHandshake(y_scalar=11, w0=w0, verifier_point=prover._multiply_point(prover._GENERATOR, w1))
cp, sp = client.get_message(), server.get_message()
cs, ss = client.finish(sp), server.finish(cp)
assert cs.transcript == ss.transcript
key = cs.verify(ss.get_confirmation())
assert key == ss.verify(cs.get_confirmation())
verifier_key, _ = prover._derive_prover_and_verifier_keys(key.hex())
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
iv = bytes(range(12))
encrypted = AESGCM(bytes.fromhex(verifier_key)).encrypt(iv, b'synthetic-device-code', b'\x00')
payload = b'\x00' + iv + encrypted[-16:] + encrypted[:-16]
bridge = dict(code='050044', salt=salt.hex(), x='7', w0=hex(w0)[2:], w1=hex(w1)[2:], clientMessage=cp, serverMessage=sp, transcript=cs.transcript.hex(), confirmation=cs.get_confirmation(), serverConfirmation=ss.get_confirmation(), ciphertext=base64.b64encode(payload).decode(), plaintext='synthetic-device-code')

proto_dir = UPSTREAM / 'pyicloud/services/reminders/protobuf'
reminders = load('reference_reminders_pb2', proto_dir / 'reminders_pb2.py')
versioned = load('reference_versioned_document_pb2', proto_dir / 'versioned_document_pb2.py')
source = ast.parse((UPSTREAM / 'pyicloud/services/reminders/_protocol.py').read_text())
encode_node = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == '_encode_crdt_document')
scope = dict(base64=base64, zlib=zlib, reminders_pb2=reminders, versioned_document_pb2=versioned)
exec(compile(ast.Module(body=[encode_node], type_ignores=[]), 'pinned_protocol.py', 'exec'), scope)
documents = []
for text in ['', 'A basic title', 'Meet ☕️ 🧑‍💻 漢字 مرحبا\nsecond line']:
    encoded = scope['_encode_crdt_document'](text)
    raw = zlib.decompress(base64.b64decode(encoded))
    doc = versioned.Document.FromString(raw)
    value = reminders.String.FromString(doc.version[0].data)
    documents.append(dict(text=text, utf16Length=len(text.encode('utf-16-le')) // 2, zlib=encoded, gzip=base64.b64encode(gzip.compress(raw, mtime=0)).decode(), raw=base64.b64encode(raw).decode(), version=base64.b64encode(doc.version[0].SerializeToString()).decode(), string=base64.b64encode(value.SerializeToString()).decode()))

source = ast.parse((UPSTREAM / 'pyicloud/hsa2_bridge.py').read_text())
names = ['_encode_varint', '_encode_field', '_encode_bytes_field', '_encode_string_field', '_encode_uint32_field', '_encode_bridge_signature', '_encode_connection_message', '_encode_web_filter_message', '_encode_ack_message']
scope = dict(NEW_CONNECTION_EXPIRATION_SECONDS=86400, BRIDGE_SIGNATURE_PREFIX=b'\x01\x03')
nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
exec(compile(ast.Module(body=nodes, type_ignores=[]), 'pinned_bridge.py', 'exec'), scope)
public_key = bytes.fromhex(cp)
nonce = b'synthetic-nonce'
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
signature = ec.derive_private_key(7, ec.SECP256R1()).sign(nonce, ec.ECDSA(hashes.SHA256(), deterministic_signing=True))
topic_hash = hashlib.sha1(b'synthetic.topic').digest()
push_body = scope['_encode_bytes_field'](1, topic_hash) + scope['_encode_uint32_field'](2, 2300) + scope['_encode_bytes_field'](4, b'{"synthetic":true}')
push = dict(topicHash=topic_hash.hex(), payload=b'{"synthetic":true}'.hex(), messageId=2300, frame=scope['_encode_bytes_field'](2, push_body).hex(), publicKey=public_key.hex(), nonce=nonce.hex(), signatureDER=signature.hex(), connection=scope['_encode_connection_message'](public_key, nonce, signature).hex(), filter=scope['_encode_web_filter_message'](['synthetic.topic']).hex(), acknowledgement=scope['_encode_ack_message'](topic_hash, 2300).hex())
result = dict(sourceRevision=PIN, srpReference='srp==1.0.22 _pysrp, RFC5054, no_username_in_x', syntheticOnly=True, srp=vectors, bridge=bridge, documents=documents, push=push)
(ROOT / 'tests/fixtures').mkdir(parents=True, exist_ok=True)
(ROOT / 'tests/fixtures/protocol.json').write_text(json.dumps(result, ensure_ascii=True, indent=2) + '\n')
print('Generated 8 synthetic SRP transcripts, 1 SPAKE2 exchange, 3 document families and bridge frames.')
