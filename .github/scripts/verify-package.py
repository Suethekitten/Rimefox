#!/usr/bin/env python3
"""校验 Release 产物，任何一项不通过都以非 0 退出。

  - ZIP 和 CRX 的文件与构建目录逐字节一致（同一份构建产物）
  - 三处的 manifest.json 版本号都等于本次版本号
  - manifest 和页面引用的资源都在包里（后台脚本、内容脚本、弹窗、设置页、图标、页面里的 JS/CSS/图片、ESM import）
  - CRX 是 CRX3 格式，签名能用其中的公钥验证通过，扩展 ID 与公钥对应
  - 包里没有隐藏文件、私钥文件、嵌套的包，任何文件内容里都没有私钥

用法：
  verify-package.py --stage <构建目录> --zip <zip> --crx <crx> --version <版本号> [--expected-id <扩展ID>]

只用标准库，验签调用 openssl 命令行。扩展 ID 不是秘密，会打印出来。
"""
import argparse
import base64
import hashlib
import io
import json
import os
import posixpath
import re
import struct
import subprocess
import sys
import tempfile
import zipfile

ZIP_ROOT = "DualTrans/"
PRIVATE_KEY_MARK = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")
FORBIDDEN_SUFFIXES = (".pem", ".key", ".crx", ".zip")
CRX_SIGNATURE_CONTEXT = b"CRX3 SignedData\x00"

errors = []


def fail(message):
    errors.append(message)


# ---------------- 读取三份文件清单 ----------------
def read_stage(stage):
    files = {}
    for dirpath, _dirs, names in os.walk(stage):
        for name in names:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, stage).replace(os.sep, "/")
            with open(full, "rb") as f:
                files[rel] = f.read()
    return files


def read_zip(data, prefix, label):
    files = {}
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        bad = zf.testzip()
        if bad:
            fail("%s 里的 %s 校验和不对，压缩包已损坏" % (label, bad))
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if prefix:
                if not name.startswith(prefix):
                    fail("%s 里的 %s 不在 %s 文件夹下" % (label, name, prefix))
                    continue
                name = name[len(prefix):]
            files[name] = zf.read(info)
    return files


# ---------------- 不该进包的东西 ----------------
def check_forbidden(files, label):
    for rel, data in files.items():
        parts = rel.split("/")
        if any(p.startswith(".") for p in parts):
            fail("%s 含隐藏文件：%s" % (label, rel))
        if rel.lower().endswith(FORBIDDEN_SUFFIXES):
            fail("%s 含私钥或打包文件：%s" % (label, rel))
        if PRIVATE_KEY_MARK.search(data):
            fail("%s 里的 %s 含有私钥内容" % (label, rel))


# ---------------- manifest 与资源完整性 ----------------
HTML_REF = re.compile(r"""(?:src|href)\s*=\s*["']([^"'#?]+)""", re.I)
JS_IMPORT = re.compile(
    r"""(?:\bimport\s*(?:[\w*{}\s,]+\s*from\s*)?|\bexport\s*[\w*{}\s,]*\s*from\s*|\bimport\s*\(\s*)["'](\.{1,2}/[^"']+)["']"""
)


def is_local(ref):
    return not re.match(r"^(?:[a-z][a-z0-9+.-]*:|//)", ref, re.I)


def resolve(base_file, ref):
    if ref.startswith("/"):
        return posixpath.normpath(ref.lstrip("/"))
    return posixpath.normpath(posixpath.join(posixpath.dirname(base_file), ref))


def check_manifest(files, version):
    raw = files.get("manifest.json")
    if raw is None:
        fail("构建目录里没有 manifest.json")
        return
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except ValueError as err:
        fail("manifest.json 不是合法 JSON：%s" % err)
        return

    if manifest.get("manifest_version") != 3:
        fail("manifest_version 不是 3")
    if manifest.get("version") != version:
        fail("manifest.json 的版本号是 %r，不是 %s" % (manifest.get("version"), version))
    for key in ("name", "version"):
        if not manifest.get(key):
            fail("manifest.json 缺少 %s" % key)

    refs = []
    background = manifest.get("background") or {}
    if background.get("service_worker"):
        refs.append(background["service_worker"])
    for cs in manifest.get("content_scripts") or []:
        refs.extend(cs.get("js") or [])
        refs.extend(cs.get("css") or [])
    action = manifest.get("action") or {}
    if action.get("default_popup"):
        refs.append(action["default_popup"])
    icon = action.get("default_icon")
    if isinstance(icon, str):
        refs.append(icon)
    elif isinstance(icon, dict):
        refs.extend(icon.values())
    refs.extend((manifest.get("icons") or {}).values())
    options = manifest.get("options_ui") or {}
    if options.get("page"):
        refs.append(options["page"])
    if manifest.get("options_page"):
        refs.append(manifest["options_page"])

    # 顺着 HTML 和 ESM 往下找，页面里用到的 JS / CSS / 图片也必须在包里
    pending = [posixpath.normpath(r) for r in refs]
    seen = set()
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        data = files.get(path)
        if data is None:
            fail("缺少资源：%s" % path)
            continue
        if path.endswith(".html"):
            for ref in HTML_REF.findall(data.decode("utf-8", "replace")):
                if is_local(ref):
                    pending.append(resolve(path, ref))
        elif path.endswith(".js"):
            for ref in JS_IMPORT.findall(data.decode("utf-8", "replace")):
                pending.append(resolve(path, ref))
    return seen


# ---------------- CRX3 解析与验签 ----------------
def read_varint(buf, pos):
    result = shift = 0
    while True:
        if pos >= len(buf):
            raise ValueError("varint 越界")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def proto_fields(buf):
    pos = 0
    while pos < len(buf):
        key, pos = read_varint(buf, pos)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = read_varint(buf, pos)
        elif wire == 2:
            length, pos = read_varint(buf, pos)
            value = buf[pos:pos + length]
            if len(value) != length:
                raise ValueError("字段长度越界")
            pos += length
        elif wire == 1:
            value, pos = buf[pos:pos + 8], pos + 8
        elif wire == 5:
            value, pos = buf[pos:pos + 4], pos + 4
        else:
            raise ValueError("不支持的 wire type %d" % wire)
        yield field, wire, value


def extension_id(crx_id_bytes):
    return "".join(chr(ord("a") + int(c, 16)) for c in crx_id_bytes.hex())


def openssl_verify(public_key_der, signature, message):
    b64 = base64.b64encode(public_key_der)
    pem = (
        b"-----BEGIN PUBLIC KEY-----\n"
        + b"\n".join(b64[i:i + 64] for i in range(0, len(b64), 64))
        + b"\n-----END PUBLIC KEY-----\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        paths = {}
        for name, data in (("pub.pem", pem), ("sig.bin", signature), ("msg.bin", message)):
            paths[name] = os.path.join(tmp, name)
            with open(paths[name], "wb") as f:
                f.write(data)
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", paths["pub.pem"], "-signature", paths["sig.bin"], paths["msg.bin"]],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return result.returncode == 0 and b"Verified OK" in result.stdout


def check_crx(data):
    """返回 (扩展 ID, 内嵌 ZIP 的字节)；格式或签名不对时记录错误并返回 (None, None)。"""
    if data[:4] != b"Cr24":
        fail("CRX 文件头不是 Cr24")
        return None, None
    version = struct.unpack("<I", data[4:8])[0]
    if version != 3:
        fail("CRX 版本是 %d，不是 3" % version)
        return None, None
    header_len = struct.unpack("<I", data[8:12])[0]
    header = data[12:12 + header_len]
    archive = data[12 + header_len:]
    if len(header) != header_len or not archive:
        fail("CRX 长度不对，文件被截断")
        return None, None

    proofs = []
    signed_header = None
    try:
        for field, wire, value in proto_fields(header):
            if field == 2 and wire == 2:  # sha256_with_rsa
                proof = {}
                for f2, w2, v2 in proto_fields(value):
                    if w2 == 2 and f2 in (1, 2):
                        proof[f2] = v2
                proofs.append(proof)
            elif field == 10000 and wire == 2:  # signed_header_data
                signed_header = value
        crx_id = None
        if signed_header is not None:
            for field, wire, value in proto_fields(signed_header):
                if field == 1 and wire == 2:
                    crx_id = value
    except ValueError as err:
        fail("CRX 头解析失败：%s" % err)
        return None, None

    if not proofs:
        fail("CRX 里没有 RSA 签名")
        return None, None
    if not crx_id or len(crx_id) != 16:
        fail("CRX 里没有有效的扩展 ID")
        return None, None

    message = CRX_SIGNATURE_CONTEXT + struct.pack("<I", len(signed_header)) + signed_header + archive
    developer_key_ok = False
    for proof in proofs:
        public_key, signature = proof.get(1), proof.get(2)
        if not public_key or not signature:
            fail("CRX 签名缺少公钥或签名值")
            continue
        if not openssl_verify(public_key, signature, message):
            fail("CRX 签名验证失败")
            continue
        if hashlib.sha256(public_key).digest()[:16] == crx_id:
            developer_key_ok = True
    if not developer_key_ok:
        fail("CRX 的扩展 ID 和签名公钥对不上")
        return None, None
    return extension_id(crx_id), archive


# ---------------- 主流程 ----------------
def digest_map(files):
    return {k: hashlib.sha256(v).hexdigest() for k, v in files.items()}


def compare(reference, other, label):
    ref, got = digest_map(reference), digest_map(other)
    missing = sorted(set(ref) - set(got))
    extra = sorted(set(got) - set(ref))
    changed = sorted(k for k in set(ref) & set(got) if ref[k] != got[k])
    if missing:
        fail("%s 缺少文件：%s" % (label, ", ".join(missing[:10])))
    if extra:
        fail("%s 多出文件：%s" % (label, ", ".join(extra[:10])))
    if changed:
        fail("%s 的文件内容和构建目录不同：%s" % (label, ", ".join(changed[:10])))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--stage", required=True)
    parser.add_argument("--zip", required=True)
    parser.add_argument("--crx", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-id", default="")
    args = parser.parse_args()

    stage = read_stage(args.stage)
    check_forbidden(stage, "构建目录")
    used = check_manifest(stage, args.version) or set()

    with open(args.zip, "rb") as f:
        zip_files = read_zip(f.read(), ZIP_ROOT, "ZIP")
    check_forbidden(zip_files, "ZIP")
    compare(stage, zip_files, "ZIP")

    with open(args.crx, "rb") as f:
        crx_data = f.read()
    if PRIVATE_KEY_MARK.search(crx_data):
        fail("CRX 文件里含有私钥内容")
    ext_id, archive = check_crx(crx_data)
    if archive is not None:
        crx_files = read_zip(archive, "", "CRX")
        check_forbidden(crx_files, "CRX")
        compare(stage, crx_files, "CRX")
    if ext_id and args.expected_id and ext_id != args.expected_id:
        fail("扩展 ID 是 %s，不是期望的 %s（是不是换了签名私钥？）" % (ext_id, args.expected_id))

    if errors:
        for message in errors:
            print("::error::" + message, file=sys.stderr)
        print("校验失败：%d 项" % len(errors), file=sys.stderr)
        return 1

    print("校验通过：")
    print("  版本号        %s（构建目录 / ZIP / CRX 一致）" % args.version)
    print("  文件数        %d（ZIP 与 CRX 均与构建目录逐字节一致）" % len(stage))
    print("  引用资源      %d 个，全部存在" % len(used))
    print("  CRX           CRX3，签名验证通过")
    print("  扩展 ID       %s" % ext_id)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write("crx_id=%s\n" % ext_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
